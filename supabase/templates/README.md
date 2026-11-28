# Tyche Cards auth emails

Paste each into Supabase (JaxsPics project) -> Authentication -> Emails -> Templates.
Sender (SMTP settings): noreply@send.techboxsolution.com, name "Tyche Cards".

| Supabase template | Subject | File |
|---|---|---|
| Confirm signup | Confirm your Tyche Cards account | `confirm-signup.html` |
| Reset password | Reset your Tyche Cards password | `reset-password.html` |
| Magic link | Your Tyche Cards sign-in link | `magic-link.html` |
| Change email address | Confirm your new email for Tyche Cards | `change-email.html` |
| Invite user | You're invited to Tyche Cards | `invite.html` |
| Reauthentication | Your Tyche Cards confirmation code | `reauthentication.html` |

Both sites share this Supabase project, so the founder site's emails use this branding too.
