# Project working rules

- After completing and validating any project change, commit the intended files and push the commit directly to `origin/main` before handing the work back to the user.
- Do not create a pull request unless the user explicitly asks for one.
- Never commit secrets, local `.env` files, generated test reports, dependency directories, or unrelated user changes.
- Run checks proportional to the change before pushing. For frontend changes, run at least `npm run typecheck`, `npm test`, and `npm run build`; for backend changes, run `go test ./...`.
