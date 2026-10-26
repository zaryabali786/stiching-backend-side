/* Stitch&Ship inside the brand's Shopify admin: Home (setup guide + permissions), Orders, Settings, What's new, Help.
   Plain JS, no build step. Polaris web components draw the page; App Bridge gives the session token every call carries. */
(() => {
  const API = '/api/shopify/embedded';
  const BASE = '/api/shopify/app';
  const root = document.getElementById('root');
  const route = location.pathname.replace(/\/+$/, '').slice(BASE.length) || '/';

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const href = (p) => `${BASE}${p === '/' ? '' : p}${location.search}`;
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private window */ } },
  };
  const toast = (msg, isError = false) => { try { window.shopify.toast.show(msg, { isError, duration: 4000 }); } catch { /* outside Shopify */ } };

  let state = null;

  const call = async (method, path, body) => {
    const token = await window.shopify.idToken();
    const res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) throw Object.assign(new Error(json.message || 'Something went wrong. Please try again.'), { status: res.status });
    return json.data;
  };

  // ───────────── pieces ─────────────

  const badge = (text, tone = 'neutral') => `<s-badge tone="${tone}">${esc(text)}</s-badge>`;

  const banner = (tone, heading, body, extra = '', dismissKey = '') =>
    `<s-banner tone="${tone}" heading="${esc(heading)}"${dismissKey ? ` dismissible data-dismiss="${esc(dismissKey)}"` : ''}>${body ? `<s-paragraph>${body}</s-paragraph>` : ''}${extra}</s-banner>`;

  const dismissed = (key) => store.get(`ss-dismiss:${key}`) === '1';

  const stepHtml = (s, i) => {
    const tone = s.done ? 'success' : s.locked ? 'neutral' : s.optional ? 'neutral' : 'warning';
    const label = s.done ? 'Done' : s.locked ? 'Needs Shopify Plus' : s.optional ? 'Optional' : 'To do';
    let actions = '';
    if (!s.locked) {
      if (s.kind === 'auto') {
        actions = s.done
          ? `<s-button variant="tertiary" data-act="setup" data-step="${s.key}">Check again</s-button>`
          : `<s-button variant="primary" data-act="setup" data-step="${s.key}">Set it up</s-button>`;
        if (!s.done && !state.permissions.up_to_date) actions += `<s-button href="${esc(state.reauthorize_url)}" target="_top">Approve new permissions</s-button>`;
      } else {
        actions = `${s.url ? `<s-button variant="${s.done ? 'tertiary' : 'secondary'}" href="${esc(s.url)}" target="_blank">Open in Shopify</s-button>` : ''}<s-checkbox data-act="mark" data-step="${s.key}" label="I've done this"${s.done ? ' checked' : ''}></s-checkbox>`;
      }
    }
    return `<li class="step${s.locked ? ' is-locked' : ''}">
      <span class="dot${s.done ? ' done' : s.locked ? ' locked' : ''}" aria-hidden="true">${s.done ? '✓' : i + 1}</span>
      <div class="step-body">
        <div class="step-title">${esc(s.title)} ${badge(label, tone)}</div>
        <div class="step-text">${esc(s.text)}</div>
        ${s.error && !s.done ? `<div class="step-error">${esc(s.error)}</div>` : ''}
        ${s.note ? `<div class="step-note">${esc(s.note)}</div>` : ''}
        ${actions ? `<div class="step-actions">${actions}</div>` : ''}
      </div>
    </li>`;
  };

  const permissionsHtml = (p, reauthorizeUrl) => `
    ${p.up_to_date ? '' : banner('warning', 'New permissions to approve', 'We added features that need your OK. It takes one click and your settings stay as they are.', `<s-button slot="secondary-actions" href="${esc(reauthorizeUrl)}" target="_top" variant="primary">Approve new permissions</s-button>`)}
    <ul class="perms">${p.groups.map((g) => `<li class="perm${g.granted ? '' : ' off'}"><span class="tick" aria-hidden="true">${g.granted ? '✓' : '!'}</span><div><b>${esc(g.title)}</b><span>${esc(g.why)}</span></div></li>`).join('')}</ul>
    <s-paragraph><s-text tone="subdued">Stitch&amp;Ship never edits your theme, prices or customers. You can remove the app at any time from Settings → Apps in Shopify.</s-text></s-paragraph>`;

  const flowHtml = `<ol class="flow">
    <li><b>Customer chooses stitching</b><span>On a product page, a customer ticks "Customise stitching with Stitch&amp;Ship" and checks out as usual.</span></li>
    <li><b>You ship to our atelier</b><span>The order goes to Stitch&amp;Ship's address. We hold the shipment until the address is checked.</span></li>
    <li><b>The customer adds sizes</b><span>We email them a link to add their measurements. We stitch the outfit and deliver it.</span></li>
  </ol>`;

  // ───────────── pages ─────────────

  const home = () => {
    const s = state;
    const pct = Math.round((s.progress.done / s.progress.total) * 100);
    const latest = s.changelog[0];
    const showNews = latest && !dismissed(`news:${latest.id}`);
    const nonPlus = s.plan && !s.plan.plus && !s.plan.development;
    const nextTodo = s.steps.find((x) => !x.done && !x.locked && !x.optional);
    return `<s-page heading="Stitch&amp;Ship" inlineSize="base">
      <s-button slot="primary-action" variant="primary" href="${href('/orders')}">View orders</s-button>
      ${showNews ? banner('info', latest.title, esc(latest.body), `<s-button slot="secondary-actions" href="${href('/updates')}">See what's new</s-button>`, `news:${latest.id}`) : ''}
      ${nonPlus && !dismissed('plan-note') ? banner('info', `Your Shopify plan is ${s.plan.name || 'not Plus'}`, 'The product page, cart and thank-you page features work on your plan. Features that change the checkout steps (the checkout badge and hiding cash on delivery at checkout) need Shopify Plus.', '', 'plan-note') : ''}
      <s-section>
        <div class="hero">
          <div class="hero-main">
            <h2>${esc(s.shop_name)}</h2>
            <p>${s.progress.done >= s.progress.total ? 'Everything is set up. Customers can now choose customised stitching on your store.' : 'Finish the steps below so customers can choose customised stitching on your store.'}</p>
            <div class="chips">${badge('Connected', 'success')}${s.plan?.name ? badge(s.plan.name, 'neutral') : ''}${s.installed_at ? `<s-text tone="subdued">Installed ${esc(fmtDate(s.installed_at))}</s-text>` : ''}</div>
          </div>
          <div class="progress">
            <div class="progress-top"><span>Setup progress</span><span>${s.progress.done} of ${s.progress.total}</span></div>
            <div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
            ${nextTodo ? `<s-button variant="primary" data-act="jump">Continue setup</s-button>` : badge('All set', 'success')}
          </div>
        </div>
      </s-section>
      <s-section heading="Your Stitch&amp;Ship orders">
        <div class="stats">
          <a class="stat" href="${href('/orders')}"><b>${s.counts.orders}</b><span>Orders so far</span></a>
          <a class="stat" href="${href('/orders')}"><b>${s.counts.waiting_for_sizes}</b><span>Waiting for customer sizes</span></a>
          <a class="stat ${s.counts.attention ? 'bad' : ''}" href="${href('/orders')}"><b>${s.counts.attention}</b><span>Need your attention</span></a>
        </div>
      </s-section>
      <s-section id="setup" heading="Setup guide">
        <ol class="steps">${s.steps.map(stepHtml).join('')}</ol>
      </s-section>
      <s-section heading="Permissions">${permissionsHtml(s.permissions, s.reauthorize_url)}</s-section>
      <s-section heading="How it works">${flowHtml}</s-section>
      <div class="foot">Stitch&amp;Ship app · version ${esc(s.version)}</div>
    </s-page>`;
  };

  const settingsPage = () => {
    const c = state.settings;
    return `<s-page heading="Settings" inlineSize="small">
      <s-button slot="breadcrumb-actions" href="${href('/')}">Home</s-button>
      <s-section>
        <div class="form">
          <s-select label="When does an order become a Stitch&amp;Ship order?" data-field="stitch_mode" details="The whole order then goes to our atelier as one order.">
            <s-option value="customer"${c.stitch_mode === 'customer' ? ' selected' : ''}>The customer ticked Stitch&amp;Ship on the product page and the product allows it (recommended)</s-option>
            <s-option value="enabled"${c.stitch_mode === 'enabled' ? ' selected' : ''}>Every product that allows Stitch&amp;Ship (no tick needed from the customer)</s-option>
          </s-select>
          <s-text-field label="Cash on delivery payment names" data-field="cod" value="${esc(c.cod_gateway_names.join(', '))}" placeholder="Cash on Delivery (COD)" details="Only needed if your store's cash on delivery method has its own name. Separate several names with commas."></s-text-field>
          <s-switch label="Also text the customer" data-field="sms" details="${c.sms_available ? 'Sends a text message with the &quot;add your sizes&quot; link, as well as the email.' : 'Text messages are not switched on for your account yet.'}"${c.sms_enabled ? ' checked' : ''}${c.sms_available ? '' : ' disabled'}></s-switch>
          <s-stack direction="inline" gap="base"><s-button variant="primary" data-act="save">Save settings</s-button></s-stack>
        </div>
      </s-section>
      <s-section heading="Your store">
        <s-paragraph><s-text tone="subdued">${esc(state.shop)}</s-text></s-paragraph>
      </s-section>
    </s-page>`;
  };

  const ordersPage = (rows) => `<s-page heading="Orders" inlineSize="large">
    <s-button slot="breadcrumb-actions" href="${href('/')}">Home</s-button>
    <s-section padding="none">
      ${rows.length
        ? `<s-table>
            <s-table-header-row><s-table-header>Order</s-table-header><s-table-header>Customer</s-table-header><s-table-header>Received</s-table-header><s-table-header>Status</s-table-header></s-table-header-row>
            <s-table-body>${rows.map((r) => `<s-table-row><s-table-cell><s-text type="strong">${esc(r.name)}</s-text></s-table-cell><s-table-cell>${esc(r.customer_email || '—')}</s-table-cell><s-table-cell>${esc(fmtTime(r.created_at))}</s-table-cell><s-table-cell>${badge(r.status.label, r.status.tone)}</s-table-cell></s-table-row>`).join('')}</s-table-body>
          </s-table>`
        : `<div class="empty"><b>No Stitch&amp;Ship orders yet</b><span>When a customer chooses stitching on your store, the order shows up here.</span><s-button href="${href('/')}">Back to setup</s-button></div>`}
    </s-section>
  </s-page>`;

  const updatesPage = () => `<s-page heading="What's new" inlineSize="small">
    <s-button slot="breadcrumb-actions" href="${href('/')}">Home</s-button>
    <s-section>
      <ul class="news">${state.changelog.map((n, i) => `<li><div class="step-title">${esc(n.title)} ${i === 0 ? badge('Latest', 'success') : ''} ${badge(n.tag, n.tag === 'New' ? 'info' : 'neutral')}</div><span class="when">${esc(fmtDate(n.date))}</span><span class="step-text">${esc(n.body)}</span></li>`).join('')}</ul>
    </s-section>
    <div class="foot">You are on version ${esc(state.version)}. Updates reach you automatically; you only need to act when we ask you to approve a new permission.</div>
  </s-page>`;

  const helpPage = () => `<s-page heading="Help" inlineSize="small">
    <s-button slot="breadcrumb-actions" href="${href('/')}">Home</s-button>
    <s-section heading="How it works">${flowHtml}</s-section>
    <s-section heading="Common questions">
      <p class="help-q">Why does a customer not see the Stitch&amp;Ship option?</p>
      <p class="help-a">The product must have "Stitch&amp;Ship available" ticked (in the product's page in Shopify), and the tick box must be added to your product page from the setup guide.</p>
      <p class="help-q">An order is "on hold". What now?</p>
      <p class="help-a">The delivery address was not our atelier's. We keep the shipment on hold and ask the customer to confirm. You do not need to do anything; the hold lifts once they confirm.</p>
      <p class="help-q">Cash on delivery is still shown at checkout.</p>
      <p class="help-a">Hiding cash on delivery and bank transfer at checkout needs Shopify Plus. On other plans the order is still held until payment is sorted out.</p>
      <p class="help-q">Do I need to approve new permissions?</p>
      <p class="help-a">Only when the Home page shows a "New permissions to approve" message. One click, and everything keeps working.</p>
      <p class="help-q">Still stuck?</p>
      <p class="help-a">Contact your Stitch&amp;Ship account manager and mention your store address: <b>${esc(state.shop)}</b>.</p>
    </s-section>
  </s-page>`;

  const errorPage = (message) => `<s-page heading="Stitch&amp;Ship">
    <s-section>${banner('critical', 'We could not load Stitch&Ship', esc(message))}<s-button variant="primary" data-act="reload">Try again</s-button></s-section>
  </s-page>`;

  // ───────────── wiring ─────────────

  const draw = async () => {
    try {
      if (route === '/orders') {
        const [s, rows] = await Promise.all([state ? Promise.resolve(state) : call('GET', '/state'), call('GET', '/orders')]);
        state = s;
        root.innerHTML = ordersPage(rows);
        return;
      }
      state = state || (await call('GET', '/state'));
      root.innerHTML = route === '/settings' ? settingsPage() : route === '/updates' ? updatesPage() : route === '/help' ? helpPage() : home();
    } catch (err) {
      root.innerHTML = errorPage(err.status === 401 ? 'Please open Stitch&Ship from Apps in your Shopify admin.' : err.message);
    }
  };

  const withBusy = async (btn, fn) => {
    if (btn) btn.setAttribute('loading', '');
    try { await fn(); } catch (err) { toast(err.message, true); } finally { if (btn) btn.removeAttribute('loading'); }
  };

  let form = {};

  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act], [data-dismiss]');
    if (!el) return;
    if (el.dataset.dismiss) return; // handled by the banner's own dismiss event
    const act = el.dataset.act;
    if (act === 'jump') document.getElementById('setup')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (act === 'reload') { state = null; draw(); }
    if (act === 'setup') {
      withBusy(el, async () => {
        const r = await call('POST', `/setup/${el.dataset.step}`);
        state = r.state;
        toast(r.ok ? 'Done. ' + (r.note ? 'See the note under the step.' : '') : r.error || 'This step could not be completed.', !r.ok);
        await draw();
      });
    }
    if (act === 'save') {
      withBusy(el, async () => {
        const body = {};
        if ('stitch_mode' in form) body.stitch_mode = form.stitch_mode;
        if ('cod' in form) body.cod_gateway_names = form.cod.split(',').map((n) => n.trim()).filter(Boolean);
        if ('sms' in form) body.sms_enabled = form.sms;
        state = await call('PUT', '/settings', body);
        form = {};
        toast('Settings saved.');
      });
    }
  });

  // checkboxes, fields and the banner's close button are custom elements: they speak through events
  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset?.act === 'mark') {
      call('PUT', `/setup/${t.dataset.step}/done`, { done: !!t.checked }).then((s) => { state = s; draw(); }).catch((err) => toast(err.message, true));
    }
    const f = t.dataset?.field;
    if (f === 'stitch_mode') form.stitch_mode = t.value;
    if (f === 'sms') form.sms = !!t.checked;
  });
  root.addEventListener('input', (e) => {
    if (e.target.dataset?.field === 'cod') form.cod = e.target.value;
  });
  root.addEventListener('dismiss', (e) => {
    const key = e.target.dataset?.dismiss;
    if (key) store.set(`ss-dismiss:${key}`, '1');
  });

  draw();
})();
