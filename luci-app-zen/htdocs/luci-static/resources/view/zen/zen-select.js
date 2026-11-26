'use strict';
'require baseclass';

let sequence = 0;
const nativeValueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');

// Keep the native value/change contract while rendering a Z Design System v2.0.0 portal listbox.
function enhance(select) {
	if (!select || select.zenPicker) return select?.zenPicker;

	const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	arrow.setAttribute('class', 'zen-picker-chevron');
	arrow.setAttribute('viewBox', '0 0 16 16');
	arrow.setAttribute('aria-hidden', 'true');
	arrow.setAttribute('focusable', 'false');
	path.setAttribute('d', 'M4 6 8 10 12 6');
	arrow.append(path);

	const wrapper = E('div', { 'class': 'zen-picker' });
	const label = E('span', { 'class': 'zen-picker-label' });
	const ariaLabel = select.getAttribute('aria-label');
	const button = E('button', {
		type: 'button',
		'class': 'zen-picker-trigger',
		role: 'combobox',
		'aria-haspopup': 'listbox',
		'aria-expanded': 'false',
		'aria-label': ariaLabel
	}, [label, arrow]);

	const list = E('div', {
		'class': 'zen-picker-list',
		role: 'listbox',
		id: 'zen-picker-' + (++sequence),
		hidden: true,
		'aria-label': ariaLabel
	});
	button.setAttribute('aria-controls', list.id);

	wrapper.append(button, list);
	select.classList.add('zen-picker-native');
	select.before(wrapper);
	select.hidden = true;

	let options = [];
	let listening = false;
	let dialogHost = null;
	let pointerInList = false;

	function makeCheck() {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		svg.setAttribute('class', 'zen-picker-check');
		svg.setAttribute('viewBox', '0 0 16 16');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '2');
		svg.setAttribute('stroke-linecap', 'round');
		svg.setAttribute('stroke-linejoin', 'round');
		svg.setAttribute('aria-hidden', 'true');
		p.setAttribute('d', 'M3.5 8.5 6.5 11.5 12.5 4.5');
		svg.append(p);
		return svg;
	}

	function rebuild() {
		options = [];
		const nodes = [];
		let idx = 0;
		const appendOption = (opt, groupDisabled) => {
			const disabled = !!(opt.disabled || groupDisabled);
			const btn = E('button', {
				type: 'button',
				role: 'option',
				'class': 'zen-picker-option',
				id: list.id + '-' + (idx++),
				'data-value': opt.value,
				title: opt.textContent,
				'aria-selected': 'false',
				'aria-disabled': disabled ? 'true' : null,
				tabindex: '-1'
			}, [
				E('span', { 'class': 'zen-picker-option-text' }, opt.textContent),
				makeCheck()
			]);
			btn.disabled = disabled;
			btn.addEventListener('click', () => {
				if (disabled) return;
				if (nativeValueDesc && nativeValueDesc.set) nativeValueDesc.set.call(select, opt.value);
				else select.value = opt.value;
				select.dispatchEvent(new Event('change', { bubbles: true }));
				sync();
				close(true);
			});
			btn.addEventListener('keydown', onOptionKeydown);
			options.push(btn);
			nodes.push(btn);
		};

		for (const child of Array.from(select.children)) {
			if (child.tagName === 'OPTGROUP') {
				if (child.label) {
					nodes.push(E('div', { 'class': 'zen-picker-group-label', role: 'presentation', title: child.label }, child.label));
				}
				for (const opt of Array.from(child.children)) {
					if (opt.tagName === 'OPTION') appendOption(opt, child.disabled);
				}
			} else if (child.tagName === 'OPTION') {
				appendOption(child, false);
			}
		}
		list.replaceChildren(...nodes);
	}

	function sync() {
		const selected = select.selectedOptions[0] || select.options[select.selectedIndex];
		label.textContent = selected ? selected.textContent : '';
		button.title = selected ? selected.textContent : '';
		button.disabled = !!select.disabled;
		const val = nativeValueDesc && nativeValueDesc.get ? nativeValueDesc.get.call(select) : select.value;
		let activeId = null;
		options.forEach(optBtn => {
			const match = optBtn.dataset.value === val;
			optBtn.setAttribute('aria-selected', String(match));
			if (match && !activeId) activeId = optBtn.id;
		});
		if (!list.hidden && activeId) button.setAttribute('aria-activedescendant', activeId);
	}

	function position() {
		if (list.hidden) return;
		if (!wrapper.isConnected) { close(false); return; }
		const anchor = button.getBoundingClientRect();
		const vv = window.visualViewport;
		const gutter = 12;
		const vx = vv ? vv.offsetLeft : 0;
		const vy = vv ? vv.offsetTop : 0;
		const vw = vv ? vv.width : document.documentElement.clientWidth;
		const vh = vv ? vv.height : window.innerHeight;
		const viewportMax = Math.max(140, vw - gutter * 2);
		const maxWidth = Math.min(viewportMax, Math.max(anchor.width, 200));
		const minWidth = Math.min(Math.max(anchor.width, 96), maxWidth);

		list.style.minWidth = minWidth + 'px';
		list.style.maxWidth = maxWidth + 'px';
		list.style.maxHeight = '260px';
		list.style.left = '0px';
		list.style.top = '0px';

		const box = list.getBoundingClientRect();
		const spaceBelow = (vy + vh) - anchor.bottom - gutter - 6;
		const spaceAbove = anchor.top - vy - gutter - 6;
		const flipUp = spaceBelow < Math.min(box.height, 220) && spaceAbove > spaceBelow;
		const availHeight = Math.max(120, Math.min(260, flipUp ? spaceAbove : spaceBelow));
		list.style.maxHeight = availHeight + 'px';

		const finalBox = list.getBoundingClientRect();
		const left = Math.max(vx + gutter, Math.min(anchor.left, vx + vw - finalBox.width - gutter));
		const top = flipUp
			? Math.max(vy + gutter, anchor.top - finalBox.height - 6)
			: Math.min(vy + vh - finalBox.height - gutter, anchor.bottom + 6);

		list.classList.toggle('flip-up', flipUp);
		list.style.left = left + 'px';
		list.style.top = top + 'px';
	}

	function onOutsidePointer(event) {
		if (!wrapper.contains(event.target) && !list.contains(event.target)) close(false);
	}

	function onKeyCapture(event) {
		if (list.hidden) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			if (event.stopImmediatePropagation) event.stopImmediatePropagation();
			close(true);
		}
	}

	function onDialogCancel(event) {
		if (!list.hidden) {
			event.preventDefault();
			close(true);
		}
	}

	function onScroll(event) {
		if (list.hidden) return;
		if (event.target === list || list.contains(event.target)) return;
		const anchor = button.getBoundingClientRect();
		if (anchor.bottom < 0 || anchor.top > window.innerHeight) close(false);
		else position();
	}

	function focusIndex(idx) {
		if (!options.length) return;
		let target = Math.max(0, Math.min(options.length - 1, idx));
		const step = idx >= 0 ? 1 : -1;
		for (let i = 0; i < options.length; i++) {
			const candidate = options[(target + i * (step || 1) + options.length) % options.length];
			if (!candidate.disabled) {
				options.forEach(o => o.classList.remove('is-active'));
				candidate.classList.add('is-active');
				button.setAttribute('aria-activedescendant', candidate.id);
				candidate.focus({ preventScroll: true });
				candidate.scrollIntoView({ block: 'nearest' });
				return;
			}
		}
	}

	function onOptionKeydown(event) {
		const idx = options.indexOf(event.currentTarget);
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			focusIndex((idx + 1) % options.length);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			focusIndex((idx - 1 + options.length) % options.length);
		} else if (event.key === 'Home') {
			event.preventDefault();
			focusIndex(0);
		} else if (event.key === 'End') {
			event.preventDefault();
			for (let i = options.length - 1; i >= 0; i--) {
				if (!options[i].disabled) { focusIndex(i); break; }
			}
		} else if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			close(true);
		} else if (event.key === 'Tab') {
			close(false);
		}
	}

	function close(returnFocus) {
		pointerInList = false;
		if (list.hidden) return;
		list.hidden = true;
		list.classList.remove('flip-up');
		button.setAttribute('aria-expanded', 'false');
		button.removeAttribute('aria-activedescendant');
		options.forEach(o => o.classList.remove('is-active'));
		if (list.parentNode !== wrapper) wrapper.appendChild(list);
		if (listening) {
			document.removeEventListener('pointerdown', onOutsidePointer, true);
			document.removeEventListener('keydown', onKeyCapture, true);
			window.removeEventListener('resize', position);
			window.removeEventListener('scroll', onScroll, true);
			window.visualViewport?.removeEventListener('resize', position);
			window.visualViewport?.removeEventListener('scroll', position);
			if (dialogHost) { dialogHost.removeEventListener('cancel', onDialogCancel, true); dialogHost = null; }
			listening = false;
		}
		if (returnFocus && button.isConnected) button.focus({ preventScroll: true });
	}

	function open(initialIndex) {
		if (select.disabled) return;
		rebuild();
		sync();
		dialogHost = wrapper.closest('dialog[open]');
		const portalTarget = dialogHost || document.body;
		if (list.parentNode !== portalTarget) portalTarget.appendChild(list);
		list.hidden = false;
		button.setAttribute('aria-expanded', 'true');
		position();

		const selectedIdx = Math.max(0, options.findIndex(o => o.getAttribute('aria-selected') === 'true'));
		focusIndex(typeof initialIndex === 'number' ? initialIndex : selectedIdx);

		if (!listening) {
			document.addEventListener('pointerdown', onOutsidePointer, true);
			document.addEventListener('keydown', onKeyCapture, true);
			window.addEventListener('resize', position);
			window.addEventListener('scroll', onScroll, true);
			window.visualViewport?.addEventListener('resize', position);
			window.visualViewport?.addEventListener('scroll', position);
			if (dialogHost) dialogHost.addEventListener('cancel', onDialogCancel, true);
			listening = true;
		}
	}

	button.addEventListener('click', () => (list.hidden ? open() : close(false)));
	button.addEventListener('keydown', event => {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			open(event.key === 'ArrowUp' ? options.length - 1 : undefined);
		} else if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			list.hidden ? open() : close(false);
		} else if (event.key === 'Escape' && !list.hidden) {
			event.preventDefault();
			event.stopPropagation();
			close(false);
		}
	});

	const clearPointerInList = () => setTimeout(() => { pointerInList = false; }, 0);
	list.addEventListener('pointerdown', () => {
		pointerInList = true;
		window.addEventListener('pointerup', clearPointerInList, { once: true });
		window.addEventListener('pointercancel', clearPointerInList, { once: true });
	}, true);

	const handleFocusOut = event => {
		if (pointerInList) return;
		const next = event.relatedTarget;
		if (next && (wrapper.contains(next) || list.contains(next))) return;
		requestAnimationFrame(() => {
			if (!pointerInList && !wrapper.contains(document.activeElement) && !list.contains(document.activeElement)) close(false);
		});
	};
	wrapper.addEventListener('focusout', handleFocusOut);
	list.addEventListener('focusout', handleFocusOut);

	select.addEventListener('change', sync);
	if (nativeValueDesc && nativeValueDesc.get && nativeValueDesc.set) {
		Object.defineProperty(select, 'value', {
			configurable: true,
			get() { return nativeValueDesc.get.call(this); },
			set(v) { nativeValueDesc.set.call(this, v); sync(); }
		});
	}

	const mo = new MutationObserver(() => { rebuild(); sync(); });
	mo.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });

	rebuild();
	sync();
	select.zenPicker = { wrapper, close, sync, refresh: () => { rebuild(); sync(); } };
	return select.zenPicker;
}

return baseclass.extend({ enhance });
