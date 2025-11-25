## Description
<!-- What does this PR do? -->


## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Database migration
- [ ] Security fix
- [ ] Refactor
- [ ] Documentation

---

## 🔒 Security Checklist (Required for PII App)

### Data Handling
- [ ] No PII is logged (console.log, error messages)
- [ ] No user data in error responses to client
- [ ] Sensitive fields are not exposed in API responses

### Authentication & Authorization
- [ ] RLS policies cover new tables/columns
- [ ] No endpoints bypass authentication
- [ ] User can only access their own data

### Secrets & Config
- [ ] No hardcoded secrets, API keys, or tokens
- [ ] Environment variables used for all config
- [ ] .env.example updated if new vars added

### Database
- [ ] Migrations are reversible (or documented why not)
- [ ] No destructive operations without backup plan
- [ ] Indexes added for new query patterns

---

## Testing
- [ ] Unit tests added/updated
- [ ] E2E tests added/updated (if UI change)
- [ ] Tested locally with real data
- [ ] Tested edge cases (empty data, large data, special chars)

---

## Deployment Notes
<!-- Any special deployment steps? Database migrations? -->


---

## Screenshots (if UI change)
<!-- Add screenshots here -->
