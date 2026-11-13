-- psql -v app_role=offramp_workspace_app -f deploy/workspace/grants.sql
-- Run as migration owner, in the DEDICATED workspace database.
-- app_role: LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION,
-- NOBYPASSRLS; MUST NOT own database/schema/tables or inherit owner.
REVOKE ALL ON SCHEMA runtime,workspace FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA runtime,workspace FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA runtime,workspace FROM PUBLIC;
GRANT USAGE ON SCHEMA runtime,workspace TO :"app_role";
GRANT SELECT ON runtime.state,runtime.journals,runtime.ledger_lines,runtime.audit,runtime.outbox TO :"app_role";
GRANT INSERT(id,document) ON runtime.state TO :"app_role";
GRANT UPDATE(document,version) ON runtime.state TO :"app_role";
-- Explicit columns: app cannot forge created_tx or ledger identity.
GRANT INSERT(id,business_key,reversal_of,created_at) ON runtime.journals TO :"app_role";
GRANT INSERT(journal_id,account,currency,debit,credit) ON runtime.ledger_lines TO :"app_role";
GRANT INSERT ON runtime.audit,runtime.outbox TO :"app_role";
GRANT USAGE ON ALL SEQUENCES IN SCHEMA runtime TO :"app_role";
GRANT SELECT,INSERT ON workspace.customers,workspace.accounts,workspace.sessions,workspace.auth_audit,workspace.rate_limits TO :"app_role";
GRANT UPDATE(revoked_at) ON workspace.sessions TO :"app_role";
GRANT UPDATE(window_start,count) ON workspace.rate_limits TO :"app_role";
GRANT SELECT,INSERT ON workspace.route_drafts TO :"app_role";
GRANT UPDATE(version,document,updated_by,updated_at) ON workspace.route_drafts TO :"app_role";
-- No DELETE/TRUNCATE, no ledger/audit UPDATE, no ownership or CREATE.

-- Partner attribution is insert-only; invitation codes and existing bindings cannot be rewritten.
GRANT SELECT,INSERT ON workspace.partners,workspace.customer_attributions TO :"app_role";
GRANT UPDATE(status,updated_at) ON workspace.partners TO :"app_role";
