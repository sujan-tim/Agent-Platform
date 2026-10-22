// Runs inside a web page, only on sites the person has allowed, only when the
// side panel asks. It does two things:
//
// - snapshot(): describes the page as text — each button, link and field on
//   it with a short ref such as [e12], then the visible text — so the agent can
//   understand the page without a screenshot;
// - act(call): performs one action (click, type, choose, key, scroll) on the
//   element with a given ref.
//
// It also answers describe(ref), which the side panel uses to decide whether
// an action needs the person's approval first (sending, submitting, buying,
// deleting…) and to refuse password fields.
//
// Refs are kept in this script's own memory (Chrome's isolated world), not
// written into the page, so the page cannot see or forge them.

(() => {
  if (window.__agentPlatform) return;

  const INTERACTIVE = [
    'a[href]',
    'button',
    'input:not([type=hidden])',
    'textarea',
    'select',
    'summary',
    '[role=button]',
    '[role=link]',
    '[role=checkbox]',
    '[role=radio]',
    '[role=switch]',
    '[role=tab]',
    '[role=menuitem]',
    '[role=menuitemcheckbox]',
    '[role=option]',
    '[role=combobox]',
    '[role=textbox]',
    '[role=searchbox]',
    '[contenteditable=""]',
    '[contenteditable=true]',
  ].join(',');

  /** Words that mark an action as one to confirm with the person first. */
  const SENSITIVE =
    /\b(send|submit|post|publish|reply|tweet|buy|purchase|order|pay|payment|checkout|check out|place order|confirm|delete|remove|discard|trash|unsubscribe|transfer|withdraw|donate|subscribe|sign up|register|book|reserve|apply|save changes|share|invite|accept|decline|approve|merge|deploy)\b/i;

  const MAX_ELEMENTS = 150;
  const MAX_TEXT = 4000;

  let counter = 0;
  const byRef = new Map();
  const refOf = new WeakMap();

  function refFor(el) {
    let ref = refOf.get(el);
    if (!ref) {
      ref = `e${++counter}`;
      refOf.set(el, ref);
    }
    byRef.set(ref, el);
    return ref;
  }

  function isVisible(el) {
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1 && !el.closest('[aria-hidden=true], [inert]');
  }

  function inViewport(el) {
    const rect = el.getBoundingClientRect();
    return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  }

  function clean(text, max = 80) {
    const flat = (text ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  }

  function labelOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText ?? '')
        .join(' ');
      if (text.trim()) return clean(text);
    }
    if (el.labels?.length) return clean([...el.labels].map((l) => l.innerText).join(' '));
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type)) return clean(el.value);
    const text = el.innerText || el.querySelector?.('img[alt]')?.alt || '';
    if (text.trim()) return clean(text);
    return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '');
  }

  function roleOf(el) {
    const role = el.getAttribute('role');
    if (role) return role;
    const tag = el.tagName;
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return 'dropdown';
    if (tag === 'TEXTAREA' || el.isContentEditable) return 'textbox';
    if (tag === 'INPUT') {
      const type = el.type;
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'search') return 'searchbox';
      if (type === 'password') return 'password';
      return 'textbox';
    }
    return 'element';
  }

  function stateOf(el, role) {
    const parts = [];
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled');
    if (el.checked || el.getAttribute('aria-checked') === 'true') parts.push('checked');
    if (el.getAttribute('aria-selected') === 'true') parts.push('selected');
    if (el.getAttribute('aria-expanded') === 'true') parts.push('expanded');
    if (role === 'dropdown' && el.selectedOptions?.[0]) parts.push(`chosen="${clean(el.selectedOptions[0].text, 40)}"`);
    if ((role === 'textbox' || role === 'searchbox') && role !== 'password') {
      const value = el.isContentEditable ? el.innerText : el.value;
      if (value) parts.push(`value="${clean(value, 60)}"`);
    }
    if (role === 'link' && el.href) {
      try {
        const url = new URL(el.href);
        parts.push(`→ ${url.host === location.host ? url.pathname + url.search : url.host + url.pathname}`.slice(0, 90));
      } catch {
        // not a usable link
      }
    }
    return parts.join(' ');
  }

  function snapshot() {
    const all = [...document.querySelectorAll(INTERACTIVE)].filter(isVisible);
    // What is on screen first, then the rest of the page, up to the limit.
    const ordered = [...all.filter(inViewport), ...all.filter((el) => !inViewport(el))].slice(0, MAX_ELEMENTS);
    const lines = ordered.map((el) => {
      const role = roleOf(el);
      const label = labelOf(el);
      const state = stateOf(el, role);
      return `[${refFor(el)}] ${role}${label ? ` "${label}"` : ''}${state ? ` ${state}` : ''}`;
    });
    const text = (document.body?.innerText ?? '').replace(/\n\s*\n+/g, '\n').trim();
    const scrolled = Math.round((scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight)) * 100);
    return {
      url: location.href,
      title: document.title,
      snapshot: [
        `Interactive elements (${all.length > ordered.length ? `first ${ordered.length} of ${all.length}; ` : ''}on screen first):`,
        ...lines,
        '',
        `Visible text${text.length > MAX_TEXT ? ` (first ${MAX_TEXT} characters)` : ''}; scrolled ${Number.isFinite(scrolled) ? scrolled : 0}% down the page:`,
        text.slice(0, MAX_TEXT),
      ].join('\n'),
    };
  }

  function isSearchForm(form) {
    return !!form && (form.getAttribute('role') === 'search' || !!form.querySelector('input[type=search], [role=searchbox]') || /search/i.test(form.action + form.id + form.className + (form.getAttribute('aria-label') ?? '')));
  }

  /** Whether `action` on `el` could send, submit, buy or delete something, so the person must approve it. */
  function needsApproval(el, action) {
    const label = labelOf(el);
    if (action === 'click') {
      if (SENSITIVE.test(label)) return true;
      const submits = (el.tagName === 'BUTTON' && (el.type === 'submit' || !el.getAttribute('type')) && el.form) || (el.tagName === 'INPUT' && ['submit', 'image'].includes(el.type));
      return !!submits && !isSearchForm(el.form);
    }
    if (action === 'enter') {
      // Enter in a single-line field submits its form; in a search box that is just a search.
      return !!el.form && !isSearchForm(el.form) && el.tagName !== 'TEXTAREA' && !el.isContentEditable;
    }
    return false;
  }

  /** What an action would touch. An empty ref means the focused element, for key presses. */
  function describe(ref, action) {
    const el = ref ? byRef.get(ref) : document.activeElement;
    if (!el || !el.isConnected) return { found: false };
    const role = roleOf(el);
    return {
      found: true,
      role,
      label: labelOf(el),
      password: role === 'password' || el.autocomplete?.includes?.('cc-') || /card.?number|cvc|cvv|security code/i.test(el.name + el.id + labelOf(el)),
      sensitive: needsApproval(el, action),
    };
  }

  /** Sets a field's value the way typing does, so pages built with React and similar notice it. */
  function setValue(el, text) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function pressKey(target, key) {
    const init = { key, code: key === 'Enter' ? 'Enter' : key, bubbles: true, cancelable: true };
    const notCancelled = target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    // A plain form does not submit on a synthetic Enter, so do what Enter would have done.
    if (key === 'Enter' && notCancelled && target.form && target.tagName === 'INPUT') target.form.requestSubmit();
  }

  function act(call) {
    const args = call.arguments ?? {};
    if (call.name === 'scroll') {
      scrollBy({ top: (args.direction === 'up' ? -0.8 : 0.8) * innerHeight, behavior: 'instant' });
      return `Scrolled ${args.direction === 'up' ? 'up' : 'down'}.`;
    }
    if (call.name === 'press_key') {
      const target = document.activeElement ?? document.body;
      pressKey(target, String(args.key ?? 'Enter'));
      return `Pressed ${args.key}.`;
    }

    const el = byRef.get(String(args.ref ?? ''));
    if (!el || !el.isConnected) return `There is no element ${args.ref} on the page now. Use a ref from the latest page.`;
    const label = labelOf(el);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });

    if (call.name === 'click') {
      if (el.disabled) return `"${label}" is disabled.`;
      el.focus?.({ preventScroll: true });
      el.click();
      return `Clicked ${roleOf(el)} "${label}".`;
    }

    if (call.name === 'type_text') {
      const text = String(args.text ?? '');
      el.focus({ preventScroll: true });
      if (el.isContentEditable) {
        // Rich editors (Gmail, Docs-like boxes) listen for real editing commands.
        document.execCommand('selectAll');
        document.execCommand('insertText', false, text);
      } else if ('value' in el) {
        setValue(el, text);
      } else {
        return `"${label}" is not a text field.`;
      }
      if (args.submit) pressKey(el, 'Enter');
      return `Typed into "${label}"${args.submit ? ' and pressed Enter' : ''}.`;
    }

    if (call.name === 'select_option') {
      if (el.tagName !== 'SELECT') return `"${label}" is not a standard drop-down. Click it, then click the option in the next page.`;
      const wanted = String(args.option ?? '').toLowerCase();
      const option = [...el.options].find((o) => o.text.trim().toLowerCase() === wanted) ?? [...el.options].find((o) => o.text.toLowerCase().includes(wanted));
      if (!option) return `No option "${args.option}" in "${label}". Options: ${[...el.options].map((o) => o.text.trim()).join(', ')}`;
      el.value = option.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return `Chose "${option.text.trim()}" in "${label}".`;
    }

    return `Unknown action ${call.name}.`;
  }

  window.__agentPlatform = { snapshot, describe, act };
})();
