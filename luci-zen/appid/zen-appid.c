/* SPDX-License-Identifier: LGPL-3.0-or-later
 * Separate nDPI worker; no payload, hostname, URL or flow log is written to disk.
 * stdin: ZAP2 + id:u64 + monotonic_ms:u64 + length:u32, then IPv4/IPv6 bytes.
 * stdout: ZAR2, 440 bytes. The first 80 bytes carry the native decision;
 * offsets 80/82: master/app u16, 84: confidence u8, 85: budget/truncation bits,
 * 86: host length u16, 88: host[256], 344: confidence name[32], 376: master name[64].
 * All integers are big endian; a zero-length message releases the flow slot.
 */
#include <ndpi_api.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <grp.h>
#include <unistd.h>
#include <sys/resource.h>
#include <sys/prctl.h>

#define SLOTS 32768
#define MAX_PACKET 4096
#define PAYLOAD_PACKETS 128
#define MAX_SAMPLED_PACKETS 136
#if NDPI_MAJOR >= 6
/* Upstream requires an explicit usage classification. The default is for
 * this project's personal/non-profit distribution, including TLS/QUIC/DNS.
 * Commercial downstream builds must select their applicable upstream mode. */
#ifndef ZEN_NDPI_LICENSE_TYPE
#define ZEN_NDPI_LICENSE_TYPE NDPI_LICENSE_NOT_FOR_PROFIT_LGPL
#endif
#endif
struct slot {
  uint64_t id;
  struct ndpi_flow_struct *flow;
  unsigned packets, payloads;
  uint16_t app;
  uint8_t state, done, limited;
  uint16_t master, raw_app;
  uint8_t confidence, budget, truncated;
  char hostname[80];
};
static struct slot slots[SLOTS];

/* Open addressing preserves every live flow when IDs share a hash bucket.
 * A release removes only its exact ID; completed decisions stay cached until
 * the daemon has consumed them and all earlier packet requests. */
static struct slot *find_slot(uint64_t id, int create) {
  for (unsigned i = 0; i < SLOTS; i++) {
    struct slot *slot = &slots[(id + i) % SLOTS];
    if (slot->state == 1 && slot->id == id) return slot;
    if (!slot->state) {
      if (!create) return NULL;
      memset(slot, 0, sizeof(*slot)); slot->id = id; slot->state = 1;
      return slot;
    }
  }
  return NULL;
}

static void release_slot(struct slot *slot) {
  if (!slot) return;
  if (slot->flow) ndpi_free_flow(slot->flow);
  unsigned hole = (unsigned)(slot - slots), next = (hole + 1) % SLOTS;
  /* Backshift deletion avoids accumulating tombstones over long uptimes. */
  for (unsigned i = 1; i < SLOTS && slots[next].state; i++, next = (next + 1) % SLOTS) {
    unsigned home = slots[next].id % SLOTS;
    if ((next + SLOTS - home) % SLOTS >= (next + SLOTS - hole) % SLOTS) {
      slots[hole] = slots[next]; hole = next;
    }
  }
  memset(&slots[hole], 0, sizeof(slots[hole]));
}

static int has_payload(const uint8_t *packet, uint32_t length) {
  unsigned header, total, protocol;
  if (length >= 20 && packet[0] >> 4 == 4) {
    header = (packet[0] & 15) * 4; total = ((unsigned)packet[2] << 8) | packet[3]; protocol = packet[9];
  } else if (length >= 40 && packet[0] >> 4 == 6) {
    header = 40; total = 40 + ((unsigned)packet[4] << 8) + packet[5]; protocol = packet[6];
  } else return 1;
  if (protocol == 6 && length >= header + 20) return total > header + (packet[header + 12] >> 4) * 4;
  return protocol != 6;
}

static uint64_t read64(const uint8_t *p) {
  uint64_t v = 0; for (int i = 0; i < 8; i++) v = (v << 8) | p[i]; return v;
}
static uint32_t read32(const uint8_t *p) {
  return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}
static int read_exact(void *p, size_t n) { return fread(p, 1, n, stdin) == n; }

/* Named applications can have native dissectors, e.g. Tencent Games. Generic
 * transports, encodings and P2P protocols remain protocol-only results; they
 * do not establish which application generated the connection. */
static int identified_service(struct ndpi_detection_module_struct *ndpi, uint16_t app) {
  switch (app) {
    case NDPI_PROTOCOL_UNKNOWN: case NDPI_PROTOCOL_HTTP: case NDPI_PROTOCOL_HTTP2:
    case NDPI_PROTOCOL_TLS: case NDPI_PROTOCOL_DTLS: case NDPI_PROTOCOL_QUIC:
    case NDPI_PROTOCOL_DNS: case NDPI_PROTOCOL_MDNS: case NDPI_PROTOCOL_DOH_DOT:
    case NDPI_PROTOCOL_DNSCRYPT: case NDPI_PROTOCOL_HTTP_CONNECT: case NDPI_PROTOCOL_HTTP_PROXY:
    case NDPI_PROTOCOL_STUN: case NDPI_PROTOCOL_RTP:
    case NDPI_PROTOCOL_HLS: case NDPI_PROTOCOL_PROTOBUF: case NDPI_PROTOCOL_BITTORRENT:
    case NDPI_PROTOCOL_OPENVPN: case NDPI_PROTOCOL_TOR: case NDPI_PROTOCOL_RAKNET:
      return 0;
#if NDPI_MAJOR >= 6
    case NDPI_PROTOCOL_MSGPACK: return 0;
#endif
    default:
#if NDPI_MAJOR >= 6
      return app < ndpi_get_num_protocols(ndpi) && ndpi_get_proto_defaults(ndpi)[app].isAppProtocol;
#else
      (void)ndpi; return 1;
#endif
  }
}

static void copy_text(uint8_t *out, size_t capacity, const char *text) {
  if (!text) return;
  size_t n = strnlen(text, capacity - 1);
  for (size_t i = 0; i < n; i++) out[i] = (uint8_t)text[i] < 32 ? '_' : text[i];
}

int main(void) {
  uint8_t header[24], packet[MAX_PACKET], response[440];
  struct ndpi_detection_module_struct *ndpi;
  struct rlimit memory = { 128ULL * 1024 * 1024, 128ULL * 1024 * 1024 };
  struct rlimit core = { 0, 0 };
  /* Recognition needs only its inherited pipes, not the daemon's privileges.
   * Bound parser memory and prevent payload-bearing crash dumps. */
  if (setrlimit(RLIMIT_AS, &memory) || setrlimit(RLIMIT_CORE, &core) ||
      prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
      (geteuid() == 0 && (setgroups(0, NULL) || setgid(65534) || setuid(65534)))) {
    fprintf(stderr, "zen-appid: unable to constrain recognition worker\n"); return 2;
  }
  if (ndpi_get_api_version() != NDPI_API_VERSION) {
    fprintf(stderr, "zen-appid: nDPI API version mismatch\n"); return 2;
  }
#if NDPI_MAJOR >= 6
  ndpi = ndpi_init_detection_module(NULL, ZEN_NDPI_LICENSE_TYPE);
#else
  ndpi = ndpi_init_detection_module(NULL);
#endif
  if (!ndpi) { fprintf(stderr, "zen-appid: nDPI initialization failed\n"); return 2; }
  /* Avoid treating default TCP/UDP ports as an application identification. */
#if NDPI_MAJOR >= 5
  ndpi_cfg_error config_result = ndpi_set_config(ndpi, NULL, "dpi.guess_on_giveup", "0");
#else
  ndpi_cfg_error config_result = ndpi_set_config(ndpi, NULL, "guess_on_giveup", "0");
#endif
  if (config_result == NDPI_CFG_OK)
    config_result = ndpi_set_config(ndpi, NULL, "packets_limit_per_flow", "136");
  int initialization_result = config_result == NDPI_CFG_OK ? ndpi_finalize_initialization(ndpi) : -1;
  if (config_result != NDPI_CFG_OK || initialization_result != 0) {
    fprintf(stderr, "zen-appid: nDPI configuration failed (config=%d, init=%d)\n", config_result, initialization_result);
    ndpi_exit_detection_module(ndpi); return 2;
  }
  setvbuf(stdout, NULL, _IONBF, 0);
  while (read_exact(header, sizeof(header))) {
    if (memcmp(header, "ZAP2", 4)) break;
    uint64_t id = read64(header + 4), time = read64(header + 12);
    uint32_t length = read32(header + 20);
    if (!id || length > MAX_PACKET) break;
    memset(response, 0, sizeof(response));
    memcpy(response, "ZAR2", 4); memcpy(response + 4, header + 4, 8);
    if (length) {
      if (!read_exact(packet, length)) break;
      struct slot *slot = find_slot(id, 1);
      if (!slot) { response[14] = 5; goto reply; }
      if (slot->done) goto decision;
      if (!slot->flow) {
        slot->flow = ndpi_flow_malloc(SIZEOF_FLOW_STRUCT);
        if (!slot->flow) { slot->done = slot->limited = 1; goto decision; }
        memset(slot->flow, 0, SIZEOF_FLOW_STRUCT);
      }
      ndpi_protocol proto = ndpi_detection_process_packet(ndpi, slot->flow, packet,
          (uint16_t)length, time, NULL);
      slot->packets++; slot->payloads += has_payload(packet, length);
      uint16_t candidate = proto.proto.app_protocol ? proto.proto.app_protocol : proto.proto.master_protocol;
      unsigned done;
#if NDPI_MAJOR >= 5
      done = slot->payloads >= PAYLOAD_PACKETS || slot->packets >= MAX_SAMPLED_PACKETS || proto.state == NDPI_STATE_CLASSIFIED;
#else
      done = slot->payloads >= PAYLOAD_PACKETS || slot->packets >= MAX_SAMPLED_PACKETS ||
          (proto.proto.app_protocol && !ndpi_extra_dissection_possible(ndpi, slot->flow));
#endif
      /* Application accounting does not need to wait for HTTP response/TLS
       * certificate metadata once a complete hostname supplied a DPI result.
       * Empty ACKs are intentionally no longer sampled just to finish that
       * metadata phase. Port/IP guesses never take this shortcut. */
      size_t host_length = strnlen(slot->flow->host_server_name, sizeof(slot->flow->host_server_name));
      if (host_length && host_length < sizeof(slot->flow->host_server_name) - 1 &&
          slot->flow->confidence == NDPI_CONFIDENCE_DPI && identified_service(ndpi,candidate)) done = 1;
      /* Giveup must have port guessing disabled (configured above). */
#if NDPI_MAJOR >= 5
      if (done && proto.state != NDPI_STATE_CLASSIFIED) {
        proto = ndpi_detection_giveup(ndpi, slot->flow);
      }
#else
      if (done && !proto.proto.app_protocol) {
        uint8_t guessed = 0;
        proto = ndpi_detection_giveup(ndpi, slot->flow, &guessed);
      }
#endif
      slot->app = proto.proto.app_protocol ? proto.proto.app_protocol : proto.proto.master_protocol;
      slot->master = proto.proto.master_protocol;
      slot->raw_app = proto.proto.app_protocol;
      slot->confidence = slot->flow->confidence;
      slot->budget = slot->payloads >= PAYLOAD_PACKETS || slot->packets >= MAX_SAMPLED_PACKETS;
      /* Copy evidence before freeing the parser. Reject potentially truncated
       * names; the daemon additionally validates DNS label boundaries. */
      memset(slot->hostname, 0, sizeof(slot->hostname));
      host_length = strnlen(slot->flow->host_server_name, sizeof(slot->flow->host_server_name));
      slot->truncated = host_length >= sizeof(slot->flow->host_server_name) - 1 || host_length >= sizeof(slot->hostname);
      if (host_length && host_length < sizeof(slot->flow->host_server_name) - 1 && host_length < sizeof(slot->hostname))
        memcpy(slot->hostname, slot->flow->host_server_name, host_length + 1);
      slot->done = done;
      if (done) { ndpi_free_flow(slot->flow); slot->flow = NULL; }
decision: ;
      uint16_t app = slot->app;
      const char *name = app ? ndpi_get_proto_name(ndpi, app) : "Unknown";
      size_t n = name ? strlen(name) : 0; if (n > 63) n = 63;
      response[12] = app >> 8; response[13] = app & 255;
      response[14] = (slot->done ? 1 : 0) | (slot->limited ? 4 : 0);
      if (identified_service(ndpi, app)) response[14] |= 2;
      response[15] = (uint8_t)n;
      for (size_t i = 0; i < n; i++) response[16 + i] = (uint8_t)name[i] < 32 ? '_' : name[i];
      response[80] = slot->master >> 8; response[81] = slot->master & 255;
      response[82] = slot->raw_app >> 8; response[83] = slot->raw_app & 255;
      response[84] = slot->confidence; response[85] = slot->budget | (slot->truncated << 1);
      size_t host_size = strlen(slot->hostname);
      response[86] = host_size >> 8; response[87] = host_size & 255;
      memcpy(response + 88, slot->hostname, host_size);
      copy_text(response + 344, 32, ndpi_confidence_get_name(slot->confidence));
      copy_text(response + 376, 64, ndpi_get_proto_name(ndpi, slot->master));
    } else {
      struct slot *slot = find_slot(id, 0);
      release_slot(slot);
      response[14] = 1;
      const char *revision = id == 1 ? ndpi_revision() : NULL;
      size_t n = revision ? strlen(revision) : 0; if (n > 63) n = 63;
      response[15] = (uint8_t)n; if (n) memcpy(response + 16, revision, n);
    }
reply:
    if (fwrite(response, 1, sizeof(response), stdout) != sizeof(response)) break;
  }
  for (unsigned i = 0; i < SLOTS; i++) if (slots[i].flow) ndpi_free_flow(slots[i].flow);
  ndpi_exit_detection_module(ndpi);
  return ferror(stdin) || ferror(stdout) ? 1 : 0;
}
