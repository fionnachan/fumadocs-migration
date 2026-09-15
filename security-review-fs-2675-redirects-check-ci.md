# Security review: `fs-2675` (`redirects-check` against the Vercel preview)

Scope: `.github/workflows/redirects-check.yml` on
`fs-2675-run-redirectscheck-in-ci-against-the-vercel-preview`, in the context of
`OffchainLabs/Fumadocs-test` being a public repository that accepts pull requests from anyone.

Verdict: **the workflow is a pwn-request pattern.** It is safe only while an assumption holds
that nothing enforces, and the act that breaks the assumption (a maintainer clicking "Authorize"
on a fork PR's Vercel preview) is a routine, low-ceremony thing a docs maintainer does. Two of the
findings below also apply to the Vercel side independently of GitHub Actions.

None of this is hypothetical timing: `gh repo view` reports the repository is **already PUBLIC**.

---

## What was verified, not assumed

| Claim                                             | How it was checked                                                       | Result                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Repo is public                                    | `gh repo view --json visibility`                                         | `PUBLIC`                                                                                               |
| Vercel previews are protected                     | `curl https://fumadocs-test-k7q3ywp22-offchain-labs.vercel.app/llms.txt` | `302 -> vercel.com/sso-api` (Vercel Authentication is ON for preview **and** production `.vercel.app`) |
| Only `merge-controlled` is a required check today | `gh api repos/.../rulesets/21063791`                                     | `required_status_checks: [merge-controlled]`, integration_id 15368 (GitHub Actions)                    |
| App reads no private env vars                     | `git grep -o 'process\.env\.[A-Z_0-9]*'`                                 | Only `NEXT_PUBLIC_*` plus Node/CI built-ins                                                            |
| Vercel gates fork deploys by default              | Vercel docs, `/docs/git/vercel-for-github`                               | Git Fork Protection requires a team member to authorize; it is a toggle, not a law                     |
| The bypass secret is injected into builds         | Vercel docs, system env vars table                                       | `VERCEL_AUTOMATION_BYPASS_SECRET` is "Available at: **both build and runtime**"                        |

The other workflows on the branch are clean. `ci.yml` is `pull_request`-triggered with
`permissions: contents: read`, `persist-credentials: false` and no secrets, so a fork PR gets the
restricted read-only token and nothing to steal. `merge-controlled.yml` has `permissions: {}` and
no checkout. `upstream-refresh.yml` is `schedule` / `workflow_dispatch` only, so no untrusted
input reaches it.

---

## Finding 1 (critical): the job runs attacker-controlled code with a secret in its environment

```yaml
on:
  deployment_status: # runs from the DEFAULT BRANCH, with full secrets access
...
- uses: actions/checkout@...
  with:
    ref: ${{ github.event.deployment.sha }} # <- the PR head commit
...
- env:
    VERCEL_AUTOMATION_BYPASS_SECRET: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}
  run: node scripts/redirects-check.mjs --base-url "$PREVIEW_URL" # <- from that checkout
```

`deployment_status` is one of the events that only ever runs the workflow file from the default
branch, and such a run is **not** a fork-PR run: it gets the full `secrets` context and a
read/write-capable `GITHUB_TOKEN` scoped by the `permissions:` block. The workflow file itself is
therefore trusted. The **checkout is not.** `deployment.sha` is whatever commit Vercel built, and
`scripts/redirects-check.mjs` plus its import `redirects.config.mjs` come out of that checkout.

An attacker's PR that edits `scripts/redirects-check.mjs` to `fetch()` the environment to their own
host exfiltrates `VERCEL_AUTOMATION_BYPASS_SECRET` on the first line it runs.

The workflow's own comment names this and then argues it away:

> What actually keeps this safe today is that the `if:` above requires
> `creator.login == 'vercel[bot]'` and this repo does not build previews for fork PRs, so
> `deployment.sha` is never attacker-controlled in practice.

Both halves of that argument are weaker than they read:

1. **`creator.login == 'vercel[bot]'` does not mean "not a fork".** Vercel creates the Deployment
   for a fork PR too. Git Fork Protection only means a team member must click "Authorize" first.
   Once they do, Vercel deploys the fork's head commit, posts a `deployment_status` with
   `creator.login: vercel[bot]` and `environment: Preview`, every clause of the `if:` passes, and
   the fork's code runs on the privileged runner. Clicking "Authorize" to look at how a
   contributor's MDX renders is exactly the reflex this repo wants maintainers to have.
2. **"this repo does not build previews for fork PRs" is a setting, not a property.** It is the
   Git Fork Protection toggle in Vercel project Settings -> Security. Nothing in this repository
   observes it, so nothing notices if it is turned off, and nothing notices the authorize click.

The load-bearing safety condition lives in another company's dashboard and in a human reflex. That
is the whole finding.

`--ignore-scripts` on the install step is real but narrow, and the comment says so honestly: it
rules out an incidental `postinstall` (this repo has one, `fumadocs-mdx`) doing the exfiltration
before the explicit `node` step does it anyway.

## Finding 2 (high): `GITHUB_TOKEN` is reachable from that same untrusted code

The step that runs untrusted code does not have `GITHUB_TOKEN` in its env, and `persist-credentials:
false` keeps it out of the git config. That is not sufficient, because the step **does** have
`GITHUB_ENV` and `GITHUB_PATH` in its env, and those name files the runner reads after every step to
build the environment of the _next_ step. Untrusted code appends a directory containing a fake `gh`
to `$GITHUB_PATH`; the final "Report result as a commit status" step then runs that `gh` with
`GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` in its environment.

The job grants `statuses: write`. A stolen token with `statuses: write` can post any state for any
context on any sha in the repo, as the `github-actions` app, which is integration_id 15368, the same
integration the one active ruleset requires. Today that only lets an attacker forge
`merge-controlled` green, and they still cannot merge. It matters more the moment the plan in the
header comment happens:

> That status can be made a required check once this is trusted enough to move into `Gates`

A required check whose token is reachable from untrusted PR code is a required check an attacker can
make green.

Fix: never put secrets and untrusted code in the same job.

## Finding 3 (medium): the bypass secret is sent to an unvalidated URL

`PREVIEW_URL` is `github.event.deployment_status.environment_url`, used with no shape or host check,
and `redirects-check.mjs` attaches `x-vercel-protection-bypass: <secret>` to a `fetch()` at that
origin.

- The `if:` validates `github.event.deployment.creator.login`, i.e. who created the _Deployment_.
  It never validates `github.event.deployment_status.creator.login`, i.e. who posted the _status_
  carrying the URL. Any actor with `deployments: write` can post an additional status, with an
  arbitrary `environment_url`, onto a Deployment that `vercel[bot]` created. That is collaborators
  and installed apps rather than drive-by contributors, so it is not the headline risk, but the
  check is one line and the consequence is "the project's bypass secret is POSTed to a host of the
  poster's choosing".
- `fetch()` follows redirects by default and undici only strips `Authorization`, `Cookie` and
  `Proxy-Authorization` across origins. A custom header such as `x-vercel-protection-bypass`
  survives a cross-origin redirect.

## Finding 4 (medium, Vercel-side, independent of Actions): creating the bypass secret weakens

deployment protection everywhere

Vercel's system env var table is explicit that `VERCEL_AUTOMATION_BYPASS_SECRET` is available **at
build time**, to every build in the project, once the secret exists. So:

- Authorizing a fork PR's preview hands that fork's build the bypass secret, with no GitHub Actions
  involved at all. Finding 1's fix does not close this.
- The secret bypasses protection on _every_ deployment in the project, not just previews. Both the
  preview and production `.vercel.app` hosts currently sit behind Vercel Authentication (verified
  above), so leaking it makes unpublished content and preview builds world-readable to whoever has
  it.

This does not mean do not create it. It means: creating it is the act that gives a fork build
something worth stealing, and it should be paired with the fork-authorization discipline in
Recommendation 5.

The good news, and it is genuinely good: `git grep` over the app finds only `NEXT_PUBLIC_*` env
vars, which are compiled into the browser bundle by definition. There is no private API key in
Preview scope for a fork build to take. Confirm `VERCEL_OIDC_TOKEN` (Secure Backend Access with
OIDC) is off for this project, since it is also build-exposed, and then the bypass secret is the
only thing of value in a build environment.

## Finding 5 (operational): this workflow cannot be tested before it is live

`deployment_status` only fires for workflow files on the default branch. Nothing in this PR runs
until it merges to `main`, at which point it is live and privileged. There is no preview-of-the-
previewer. Every hardening below therefore has to land in this same PR, not as a follow-up.

---

## Recommendations

### R1 (must): enforce the fork assumption instead of documenting it

Turn "this repo does not build previews for fork PRs" from a comment into a gate that fails closed.
The `deployment_status` payload does not carry the PR head repo, so resolve it:

```yaml
- name: Refuse to run for a commit that is not from this repository
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    REPO: ${{ github.repository }}
    SHA: ${{ github.event.deployment.sha }}
  run: |
    # Every PR containing this sha must have its head in this repo, and there must be
    # at least one. An empty list means a branch push with no PR, or a sha we cannot
    # attribute; both fail closed. Runs BEFORE any checkout.
    prs=$(gh api "repos/$REPO/commits/$SHA/pulls" \
            --jq '[.[] | .head.repo.full_name] | @json')
    same=$(gh api "repos/$REPO/commits/$SHA/pulls" \
            --jq '[.[] | select(.head.repo.full_name == env.REPO)] | length')
    total=$(gh api "repos/$REPO/commits/$SHA/pulls" --jq 'length')
    if [ "$total" -eq 0 ] || [ "$same" -ne "$total" ]; then
      echo "::error::Refusing to check out $SHA: head repos $prs (expected only $REPO)."
      echo "A fork preview runs contributor code on a runner that holds this project's"
      echo "Vercel bypass secret. See security-review-fs-2675-redirects-check-ci.md."
      exit 1
    fi
```

This is not belt-and-braces over R2 and R3, it is the check that makes the existing `--ignore-scripts`
comment true.

### R2 (must): split the job so no secret shares a job with untrusted code

Three jobs instead of one. Only the first and third hold `GITHUB_TOKEN`, and neither checks out the
PR. The middle job does the untrusted work with `permissions: {}`.

```yaml
jobs:
  pending:
    if: <the existing if:>
    permissions: { statuses: write }
    # posts state=pending. No checkout.

  check:
    needs: [pending]
    permissions: {} # no GITHUB_TOKEN reaches this job at all
    # R1 gate cannot live here (it needs a token); keep it in `pending` and let
    # `needs` stop this job when it fails.
    # checkout deployment.sha, pnpm install --ignore-scripts, run the check.

  report:
    needs: [check]
    if: always() && needs.check.result != 'cancelled'
    permissions: { statuses: write }
    # posts success/failure from needs.check.result. No checkout.
```

With `permissions: {}` on `check`, poisoning `GITHUB_PATH` or `GITHUB_ENV` gains the attacker
nothing: there is no later step in that job with a token, and the job's own token has no scopes.
The `cancelled` guard the current workflow has on the report step moves onto the `report` job's
`if:` unchanged, and keeps working for the same reason.

The `VERCEL_AUTOMATION_BYPASS_SECRET` still has to be in `check`. That is what R1 and R5 are for.

### R3 (must): pin the host before the secret goes anywhere

Two small changes:

1. Add `github.event.deployment_status.creator.login == 'vercel[bot]'` to the `if:`, alongside the
   existing check on `deployment.creator.login`.
2. Validate `environment_url` in the workflow before it becomes `PREVIEW_URL`, and again in
   `scripts/lib/redirects-check.mjs` where `parseArgs` already normalises the base URL. Require
   `https:` and a host ending in `.vercel.app` (tighten to the `fumadocs-test-` prefix if you want
   it exact). Fail with a message naming the rejected host rather than falling back to the default
   `http://localhost:3000`, which is what `parseArgs` would silently do with an empty value today.

`parseArgs` is already unit tested in `scripts/redirects-check.test.mjs`, so this is a cheap place
to add a case: a non-`.vercel.app` base URL must throw rather than be used with a bypass header.

Optional third: pass `redirect: 'manual'` on the `/llms.txt` fetch, or re-check the host of
`response.url` before trusting the body, so a redirect cannot walk the header off-origin.

### R4 (should): keep the secret out of the scripted path when it is not needed

`parseArgs` falls back to `env.VERCEL_AUTOMATION_BYPASS_SECRET` and defaults to `''`. That is a good
default. Keep it, and make the CI step pass the secret only when the host check in R3 passed.

### R5 (should): write down what "Authorize" means on a fork PR

Because of Finding 4, this belongs in `CONTRIBUTING.md` / the maintainer notes, not only in a
workflow comment:

- Git Fork Protection stays **ON**. Confirm it in Vercel project Settings -> Security.
- Clicking "Authorize" on a fork PR executes that contributor's code in a Vercel build that holds
  `VERCEL_AUTOMATION_BYPASS_SECRET`. Authorize only after reading the diff, and only for diffs that
  touch `content/**` and nothing else. A fork PR that edits `scripts/`, `package.json`,
  `pnpm-lock.yaml`, `next.config.mjs`, `source.config.ts` or `.github/**` does not get authorized
  on reflex.
- Rotate the bypass secret in Vercel after any fork authorization, and on a schedule regardless.
- Confirm OIDC (Secure Backend Access) is off, so `VERCEL_OIDC_TOKEN` is not in build environments.

### R6 (optional): migrate the trigger to `repository_dispatch`

Vercel now recommends `repository_dispatch` with `types: ['vercel.deployment.success']` over
`deployment_status`, and the URL moves to `github.event.client_payload.url`. It is cheaper, since
the workflow stops firing on every state transition. It has **identical** trust properties, so it is
not a fix for anything above. Do it only if you want it for its own sake.

---

## The short version

Everything except `redirects-check.yml` on this branch is fine. `redirects-check.yml` puts the
project's Vercel bypass secret, and a token that can write commit statuses, on a runner that then
executes code from a pull request, and the only thing standing between that and a stranger's PR is a
Vercel dashboard toggle plus a maintainer not clicking a button that the product invites them to
click. R1 and R2 are the two that matter: enforce the fork condition, and stop the secret and the
untrusted code sharing a job. R3 is two lines. R5 is the one that covers the Vercel-side hole that
no amount of workflow YAML can close.
