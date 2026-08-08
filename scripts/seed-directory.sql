-- DeltaLog directory seed
-- Generated 2026-08-08T19:59:18.212Z by scripts/seed-directory.ts
-- Resolved 31 of 60 vendors against the live web.
--
-- Re-running is safe: ids are deterministic and every statement is INSERT OR IGNORE.
--
-- Not seeded (29) — add by hand or let a later pass retry:
--   aws              no candidate path exists
--   azure            no candidate path exists
--   heroku           no candidate path exists
--   netlify          pages answered but none proved to be a subprocessor list
--   akamai           blocked by bot protection
--   elastic          no candidate path exists
--   sendgrid         pages answered but none proved to be a subprocessor list
--   slack            no candidate path exists
--   zoom             pages answered but none proved to be a subprocessor list
--   loom             pages answered but none proved to be a subprocessor list
--   notion           no candidate path exists
--   linear           pages answered but none proved to be a subprocessor list
--   gitlab           blocked by bot protection
--   mongodb          no candidate path exists
--   segment          pages answered but none proved to be a subprocessor list
--   salesforce       pages answered but none proved to be a subprocessor list
--   hubspot          no candidate path exists
--   zendesk          no candidate path exists
--   okta             pages answered but none proved to be a subprocessor list
--   auth0            no candidate path exists
--   docusign         no candidate path exists
--   dropbox          no candidate path exists
--   box              blocked by bot protection
--   workday          no candidate path exists
--   bamboohr         no candidate path exists
--   gusto            blocked by bot protection
--   rippling         no candidate path exists
--   openai           blocked by bot protection
--   anthropic        pages answered but none proved to be a subprocessor list

INSERT OR IGNORE INTO workspaces (id, name, plan, created_at)
VALUES ('system-directory', 'DeltaLog Directory', 'compliance', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-google-cloud', 'system-directory', 'google-cloud',
  'https://cloud.google.com/terms/subprocessors', 'subprocessor_list', 1440, '2026-08-08T19:59:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-digitalocean', 'system-directory', 'digitalocean',
  'https://www.digitalocean.com/trust/subprocessors', 'subprocessor_list', 1440, '2026-08-08T20:04:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-vercel', 'system-directory', 'vercel',
  'https://vercel.com/trust/subprocessors', 'subprocessor_list', 1440, '2026-08-08T20:09:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-cloudflare', 'system-directory', 'cloudflare',
  'https://www.cloudflare.com/gdpr/subprocessors/cloudflare-services/', 'subprocessor_list', 1440, '2026-08-08T20:14:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-fastly', 'system-directory', 'fastly',
  'https://docs.fastly.com/products/sub-processors', 'subprocessor_list', 1440, '2026-08-08T20:19:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-datadog', 'system-directory', 'datadog',
  'https://www.datadoghq.com/legal/subprocessors/', 'subprocessor_list', 1440, '2026-08-08T20:24:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-new-relic', 'system-directory', 'new-relic',
  'https://newrelic.com/sub-processors', 'subprocessor_list', 1440, '2026-08-08T20:29:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-sentry', 'system-directory', 'sentry',
  'https://sentry.io/legal/subprocessors/', 'subprocessor_list', 1440, '2026-08-08T20:34:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-grafana', 'system-directory', 'grafana',
  'https://grafana.com/legal/list-of-subprocessors/', 'subprocessor_list', 1440, '2026-08-08T20:39:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-pagerduty', 'system-directory', 'pagerduty',
  'https://www.pagerduty.com/subprocessors/', 'subprocessor_list', 1440, '2026-08-08T20:44:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-stripe', 'system-directory', 'stripe',
  'https://stripe.com/legal/service-providers', 'subprocessor_list', 1440, '2026-08-08T20:49:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-twilio', 'system-directory', 'twilio',
  'https://www.twilio.com/en-us/legal/sub-processors', 'subprocessor_list', 1440, '2026-08-08T20:54:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-calendly', 'system-directory', 'calendly',
  'https://calendly.com/help/calendly-sub-processors-gdpr-ccpa', 'subprocessor_list', 1440, '2026-08-08T20:59:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-airtable', 'system-directory', 'airtable',
  'https://www.airtable.com/company/subprocessors', 'subprocessor_list', 1440, '2026-08-08T21:04:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-asana', 'system-directory', 'asana',
  'https://asana.com/terms/subprocessors', 'subprocessor_list', 1440, '2026-08-08T21:09:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-monday', 'system-directory', 'monday',
  'https://monday.com/l/privacy/sub-processors-subsidiaries-support/', 'subprocessor_list', 1440, '2026-08-08T21:14:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-atlassian', 'system-directory', 'atlassian',
  'https://www.atlassian.com/legal/sub-processors', 'subprocessor_list', 1440, '2026-08-08T21:19:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-miro', 'system-directory', 'miro',
  'https://trust.miro.com/', 'subprocessor_list', 1440, '2026-08-08T21:24:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-figma', 'system-directory', 'figma',
  'https://www.figma.com/sub-processors/', 'subprocessor_list', 1440, '2026-08-08T21:29:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-github', 'system-directory', 'github',
  'https://docs.github.com/en/site-policy/privacy-policies/github-subprocessors', 'subprocessor_list', 1440, '2026-08-08T21:34:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-launchdarkly', 'system-directory', 'launchdarkly',
  'https://launchdarkly.com/subprocessors/', 'subprocessor_list', 1440, '2026-08-08T21:39:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-zapier', 'system-directory', 'zapier',
  'https://zapier.com/legal/subprocessors', 'subprocessor_list', 1440, '2026-08-08T21:44:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-snowflake', 'system-directory', 'snowflake',
  'https://www.snowflake.com/en/legal/privacy/snowflake-sub-processors/', 'subprocessor_list', 1440, '2026-08-08T21:49:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-databricks', 'system-directory', 'databricks',
  'https://www.databricks.com/legal/databricks-subprocessors', 'subprocessor_list', 1440, '2026-08-08T21:54:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-amplitude', 'system-directory', 'amplitude',
  'https://amplitude.com/subprocessor-list', 'subprocessor_list', 1440, '2026-08-08T21:59:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-mixpanel', 'system-directory', 'mixpanel',
  'https://mixpanel.com/legal/subprocessor-list/', 'subprocessor_list', 1440, '2026-08-08T22:04:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-intercom', 'system-directory', 'intercom',
  'https://www.intercom.com/legal/subprocessors-list', 'subprocessor_list', 1440, '2026-08-08T22:09:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-mailchimp', 'system-directory', 'mailchimp',
  'https://mailchimp.com/legal/subprocessors/', 'subprocessor_list', 1440, '2026-08-08T22:14:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-klaviyo', 'system-directory', 'klaviyo',
  'https://www.klaviyo.com/legal/subprocessors', 'subprocessor_list', 1440, '2026-08-08T22:19:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-braze', 'system-directory', 'braze',
  'https://www.braze.com/company/legal/subprocessors', 'subprocessor_list', 1440, '2026-08-08T22:24:18.212Z', '2026-08-08T19:59:18.212Z');

INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES ('dir-1password', 'system-directory', '1password',
  'https://1password.com/legal/saas-manager/third-party-sub-processors', 'subprocessor_list', 1440, '2026-08-08T22:29:18.212Z', '2026-08-08T19:59:18.212Z');
