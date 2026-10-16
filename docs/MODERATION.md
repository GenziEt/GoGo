# GENZI Automated Moderation

## Hard actions

### BAN / immediate block
- Sexual exploitation
- Non-consensual intimate content

### REJECT
- Scam patterns
- Fraud patterns
- Links from normal users
- Forwarded content

### Allowed but monitored
- Harassment
- Doxxing
- Threats
- Hate speech
- Dangerous content

These categories are intentionally not blanket-rejected because the owner requested that they may proceed. They remain visible to the moderation/audit layer so the system can be extended with human review later.

## Identity
Anonymous posts are anonymous to the public, but the system retains Telegram identity internally for safety enforcement.

## No paid moderation dependency
The initial implementation is deterministic and local. An AI moderation adapter can be introduced later without changing the post workflow.
