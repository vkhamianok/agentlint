---
severity: warning
---

# Single responsibility

One function, file, or document does one job. Mixed responsibilities make
every future change riskier: touching one concern shakes the others that
happen to live next to it.

## Flag

- new code that mixes unrelated concerns in one unit (a function that
  validates, saves, and sends email);
- a change that grows an existing unit into a mix instead of splitting it;
- grab-bag modules accumulating unrelated helpers because the file was
  already open.

## Do not flag

- small cohesive units that orchestrate others — coordination is itself a
  single responsibility;
- pragmatic colocation of tiny helpers used only by the code next to them.

## Examples

### Bad

```js
async function registerUser(input) {
  if (!input.email.includes('@')) throw new Error(`bad email: ${input.email}`);
  const user = await db.users.insert(input);
  await smtp.send(user.email, 'Welcome!');
  metrics.increment('signup');
  return user;
}
```

### Good

```js
async function registerUser(input) {
  validateRegistration(input);
  const user = await db.users.insert(input);
  await onUserRegistered(user); // email + metrics live with their concerns
  return user;
}
```
