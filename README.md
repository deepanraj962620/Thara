# Thara HDB Admin RPC Fixed v3

## IMPORTANT
1. Supabase -> SQL Editor -> paste the full `supabase.sql` and Run.
2. GitHub: replace project files with this ZIP's files and commit.
3. Render: Deploy latest commit.
4. Submit one complete quiz. The final page now only opens after Supabase confirms the row was saved.
5. Admin login: username `thara`, password `thara2008`.

Admin table shows `Time | Answer` and includes Delete.

This v3 saves via `submit_love_response()` RPC, so it does not depend on direct table INSERT policy/privileges. It also no longer silently stores failed submissions only in localStorage.
