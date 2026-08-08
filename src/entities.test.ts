import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffEntities, extractEntities, normalizeEntityName } from './entities.ts';

const STANDARD_TABLE = `
<h2>Our Subprocessors</h2>
<table>
  <thead><tr><th>Subprocessor</th><th>Purpose</th><th>Location</th></tr></thead>
  <tbody>
    <tr><td><a href="https://snowflake.com">Snowflake&nbsp;Inc.</a></td><td>Data warehousing</td><td>United States</td></tr>
    <tr><td>Cloudflare, Inc.[1]</td><td>CDN &amp; DDoS protection</td><td>United States</td></tr>
    <tr><td>Hetzner Online GmbH</td><td>Hosting</td><td>Germany</td></tr>
  </tbody>
</table>`;

test('parses a standard subprocessor table', () => {
  const entities = extractEntities(STANDARD_TABLE);
  assert.equal(entities.length, 3);
  assert.deepEqual(entities[0], { name: 'Snowflake Inc.', purpose: 'Data warehousing', jurisdiction: 'United States' });
});

test('decodes entities and strips footnote markers and links', () => {
  const [, cloudflare] = extractEntities(STANDARD_TABLE);
  assert.equal(cloudflare.name, 'Cloudflare, Inc.');
  assert.equal(cloudflare.purpose, 'CDN & DDoS protection');
});

test('maps alternative column names', () => {
  const entities = extractEntities(`
    <table>
      <tr><th>Entity</th><th>Service provided</th><th>Country</th><th>Categories of personal data</th></tr>
      <tr><td>Stripe, Inc.</td><td>Payments</td><td>US</td><td>Billing details</td></tr>
    </table>`);
  assert.deepEqual(entities, [{ name: 'Stripe, Inc.', purpose: 'Payments', jurisdiction: 'US' }]);
});

test('"Location of processing" is a jurisdiction, not a purpose', () => {
  const [e] = extractEntities(`
    <table>
      <tr><th>Third party</th><th>Location of processing</th></tr>
      <tr><td>Twilio Inc.</td><td>Ireland</td></tr>
    </table>`);
  assert.equal(e.jurisdiction, 'Ireland');
  assert.equal(e.purpose, undefined);
});

test('handles header cells in the body and no thead', () => {
  const entities = extractEntities(`
    <table>
      <tr><td>Vendor</td><td>Purpose</td></tr>
      <tr><th>Datadog, Inc.</th><td>Monitoring</td></tr>
    </table>`);
  assert.deepEqual(entities, [{ name: 'Datadog, Inc.', purpose: 'Monitoring', jurisdiction: undefined }]);
});

test('skips full-width section-divider rows', () => {
  const entities = extractEntities(`
    <table>
      <tr><th>Subprocessor</th><th>Purpose</th><th>Region</th></tr>
      <tr><td colspan="3">EMEA</td></tr>
      <tr><td>Hetzner Online GmbH</td><td>Hosting</td><td>Germany</td></tr>
    </table>`);
  assert.deepEqual(entities.map((e) => e.name), ['Hetzner Online GmbH']);
});

test('a pricing table is not a subprocessor list', () => {
  assert.deepEqual(
    extractEntities(`
      <table>
        <tr><th>Plan</th><th>Price</th></tr>
        <tr><td>Free</td><td>$0</td></tr>
        <tr><td>Team</td><td>$39</td></tr>
        <tr><td>Compliance</td><td>$99</td></tr>
      </table>`),
    [],
  );
});

test('a name column alone is declined — better silent than fabricated', () => {
  assert.deepEqual(
    extractEntities(`
      <table>
        <tr><th>Company</th></tr>
        <tr><td>Snowflake Inc.</td></tr>
        <tr><td>Stripe, Inc.</td></tr>
      </table>`),
    [],
  );
});

test('an unlabelled first column is accepted when its values read like organisations', () => {
  const entities = extractEntities(`
    <table>
      <tr><th>Who</th><th>Purpose</th><th>Country</th></tr>
      <tr><td>Snowflake Inc.</td><td>Warehousing</td><td>US</td></tr>
      <tr><td>Stripe, Inc.</td><td>Payments</td><td>US</td></tr>
    </table>`);
  assert.deepEqual(entities.map((e) => e.name), ['Snowflake Inc.', 'Stripe, Inc.']);
});

test('merges per-product tables, filling in missing fields', () => {
  const entities = extractEntities(`
    <table>
      <tr><th>Subprocessor</th><th>Purpose</th></tr>
      <tr><td>Amazon Web Services, Inc.</td><td>Hosting</td></tr>
    </table>
    <table>
      <tr><th>Subprocessor</th><th>Location</th></tr>
      <tr><td>Amazon Web Services Inc</td><td>United States</td></tr>
    </table>`);
  assert.equal(entities.length, 1);
  assert.deepEqual(entities[0], { name: 'Amazon Web Services, Inc.', purpose: 'Hosting', jurisdiction: 'United States' });
});

test('a list under a subprocessor heading is parsed', () => {
  const entities = extractEntities(`
    <h2>Sub-processors</h2>
    <ul>
      <li>Snowflake Inc. — Data warehousing (United States)</li>
      <li>Stripe, Inc. — Payments (United States)</li>
      <li>Hetzner Online GmbH — Hosting (Germany)</li>
    </ul>`);
  assert.equal(entities.length, 3);
  assert.deepEqual(entities[1], { name: 'Stripe, Inc.', purpose: 'Payments', jurisdiction: 'United States' });
});

test('a nav menu with no subprocessor heading yields nothing', () => {
  assert.deepEqual(
    extractEntities(`
      <nav><ul><li><a href="/pricing">Pricing</a></li><li><a href="/docs">Docs</a></li><li><a href="/blog">Blog</a></li></ul></nav>
      <h2>Welcome</h2>`),
    [],
  );
});

test('script and style content never becomes an entity', () => {
  assert.deepEqual(
    extractEntities(`
      <h2>Subprocessors</h2>
      <script>var vendors = ["<li>Evil Corp</li>", "<li>Bad Inc</li>", "<li>Worse LLC</li>"];</script>`),
    [],
  );
});

test('entity identity survives suffix reformatting', () => {
  assert.equal(normalizeEntityName('Snowflake Inc.'), normalizeEntityName('Snowflake, Inc'));
  assert.equal(normalizeEntityName('Acme Company Ltd.'), 'acme');
  assert.notEqual(normalizeEntityName('Acme Data'), normalizeEntityName('Acme Cloud'));
});

test('a reordered jurisdiction list is not a jurisdiction change', () => {
  // GitHub regenerated its page and listed the same three countries in a new order.
  const before = [{ name: 'Fireworks AI', jurisdiction: 'United States, Iceland, Germany' }];
  const after = [{ name: 'Fireworks AI', jurisdiction: 'United States, Germany, Iceland' }];
  assert.deepEqual(diffEntities(before, after).moved, []);
});

test('adding a jurisdiction to the list still counts', () => {
  const before = [{ name: 'Acme', jurisdiction: 'United States, Germany' }];
  const after = [{ name: 'Acme', jurisdiction: 'United States, Germany, India' }];
  assert.equal(diffEntities(before, after).moved.length, 1);
});

test('aliases still resolve inside a list', () => {
  const before = [{ name: 'Acme', jurisdiction: 'USA, Germany' }];
  const after = [{ name: 'Acme', jurisdiction: 'Germany, United States' }];
  assert.deepEqual(diffEntities(before, after).moved, []);
});
