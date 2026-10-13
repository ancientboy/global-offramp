# Authentication integration boundary

The current app is an isolated mock demo. The role switch chooses a named server fixture through `x-demo-actor`; it is not an account login, a verified session or a real maker/checker identity. All API production startup is refused. Neither a UI toggle nor a `READY=true` environment variable can activate real authentication or money execution.

## Implemented contract

`packages/core/src/adapters.ts` contains `IdentityProvider.verifyAccessToken(token)` returning a verified issuer, audience, subject, expiration, authentication methods and session ID. `UnconfiguredIdentityProvider` always throws `PRODUCTION_AUTH_REQUIRED`, covered by a test. This is an integration port, not a token verifier.

## Integration sequence after a provider is chosen

1. Implement the provider adapter using the provider's maintained SDK or reviewed OIDC/JWT verification. Require expected issuer and audience, allowed algorithms, signature validation, token expiration and key rotation. Never trust a decoded-but-unverified JWT.
2. Bind the verified issuer + subject to a server-owned account/actor. Resolve roles, customer ownership, suspension and partner attribution from trusted storage. Do not accept role/customer/partner IDs from headers, form fields or arbitrary token claims.
3. Require verified staff MFA and step-up/recent authentication for payout/refund/settlement review. Separate human identities must remain separate even if one person can select multiple demo roles.
4. Implement session logout, revocation, refresh, short lifetimes, abuse limits and auditable actor/session IDs. Decide token storage and CSRF strategy based on browser session design.
5. Replace and remove the demo guard from production modules. Do not weaken `assertSafeRuntime` until independent identity, authorization and deployment acceptance passes.
6. Test tenant isolation, cross-account resource IDs, suspended users, wrong audience/issuer, expired tokens, key rotation, revoked sessions, missing MFA and privilege changes. Repeat domain maker/checker checks with real principals.

## Can proceed locally without choosing a provider

- Expand permission and ownership tests against a verifier test double while keeping production startup closed
- Extract role-specific Nest modules and repository adapters
- Add deterministic API/UI integration scenarios and error/retry coverage
- Implement private-storage contract mocks and metadata validation tests
- Map the runtime model to a reconciled normalized schema and test migrations on disposable data

A provider choice is needed for actual login integration, not for continuing the above safe local engineering work. The legal funds-flow review and payout provider contracts likewise do not block improving the mock application.
