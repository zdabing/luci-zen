import * as fs from 'fs';
const policy = loadfile(ARGV[0])();
for (const test in json(fs.readfile(ARGV[1]))) {
    let failed = false;
    try {
        const file = policy.candidate(test.release, test.request, test.board, test.current);
        assert(!test.error && file.filename == test.expected, 'Unexpected accepted package');
    } catch (e) {
        if (!test.error || index(e.message, test.error) < 0) die(e.message);
        failed = true;
    }
    assert(failed == !!test.error, 'Expected rejection');
}
print('PASS: production ucode update policy\n');
