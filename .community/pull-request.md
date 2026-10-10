# Pull request text for the awesome-dsh-plugin listing

- Target: https://github.com/awesome-dsh-plugin/awesome-dsh-plugin (branch `main`)
- File to add: `data/plugins/B1aZerr__dsh-net-switch.yml`
  (copy of [awesome-dsh-plugin.yml](awesome-dsh-plugin.yml) next to this file)
- Nothing else is touched: both READMEs are generated from `data/plugins/*.yml`.
- **Do not open this before the repository is 24 hours old** — CI checks repo age
  first, and an earlier PR is rejected on that check alone.

## Title

```
Add dsh-net-switch
```

## Body

```markdown
Adds `data/plugins/B1aZerr__dsh-net-switch.yml` — one file, nothing else touched.

**What it does.** A runtime switch for Harness's own outbound traffic. Harness
resolves its egress policy once, before any plugin loads (`@deepseek-ai/dsh-http-proxy`
reads the launch environment), and ignores the Windows system proxy — so changing the
route otherwise means editing environment variables and restarting. This plugin replaces
the process-global undici dispatcher with one that decides per request, so `clash`
(through a local Clash Verge proxy) and `lan` (direct) can be flipped at runtime and
reverted, from a status pill in the top-right of the web GUI, a `network_mode` agent
tool, or `/net`. The same flip rewrites child-process proxy variables, so `git`, `curl`
and `npm` follow the same route. Loopback and every private range
(`10/8`, `172.16/12`, `192.168/16`, `169.254/16`) always stay direct; the last choice is
persisted; an unreachable proxy fails open but keeps reporting `degraded: true` instead
of silently pretending to be connected.

**Overlap with an existing entry.** `Lunatic029/dsh-clash-proxy` is already listed and is
the closest neighbour, so here is the difference rather than a claim to the same slot: it
resolves its proxy once at startup from config or the environment (with an automatic
fallback to direct), so the route cannot be changed without restarting; this one is
switchable at runtime in both directions and puts the switch in the GUI, in the agent's
tool list and on the command line. I filed it under `remote` to sit beside that entry —
happy to have it re-filed if you would rather it live elsewhere.

`tarball:` points at the release asset. The asset filename carries no version, so
`releases/latest/download/dsh-net-switch.tgz` keeps resolving after future releases.

**Checks.** `package.json` declares `dsh.bundle` (`patch: ./cordis.patch.yml`) and
`dsh.client` (`platform: web`); the `dsh-plugin` topic is set. Verified end to end on DSH
Desktop 0.2.0-rc.2 against Clash Verge Rev on `127.0.0.1:7897`: clicking the pill moves
`lan → clash → lan` with `lastChangeSource=gui`, agent shells gain and then lose
`HTTP(S)_PROXY` / `NO_PROXY` / `NODE_USE_ENV_PROXY`, a direct
`fetch('https://www.google.com/generate_204')` goes from timeout to `204` through the
proxy, and 21 tests pass — including a real CONNECT proxy driving process-global `fetch`
to prove the routing itself.

在「走本地 Clash Verge 代理」与「直连（含局域网）」之间运行时切换 Harness 自己的出网；
与已收录的 `dsh-clash-proxy` 的区别是「运行时双向可切 + 三个入口」，而不是启动时定死。
```

## After the PR

- CI reports on the PR; a failure names exactly what to change, and a fix is pushed to
  the same branch — no new PR needed.
- Merging regenerates both READMEs on `main`; the site rebuilds automatically. Nothing
  else needs touching.
