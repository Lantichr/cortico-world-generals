Owner: [`src/client.ts`](../src/client.ts), [`src/simulation.ts`](../src/simulation.ts), [`src/agent/`](../src/agent/), [`src/ENV_PROMPT.md`](../src/ENV_PROMPT.md) and [`src/viewer/web/`](../src/viewer/web/).

# Sources and research references

## Protocol and mechanics

- [generals.io Bot API](https://dev.generals.io/api): account, room and game event vocabulary. Its Engine.IO 3 connection example predates the current Bot Server client; this integration uses Engine.IO 4.
- [Official homepage](https://generals.io/) and its linked [client v31.4.3](https://generals.io/generals-main-prod-v31.4.3-485dbf55.js): turn production, tutorial timing, City-State initialization and the default player palette. These links describe the version examined, and can change or become unavailable.

That client defines `RECRUIT_RATE=2` and `FARM_RATE=50`: generals and owned cities receive one army every two server turns; all owned tiles receive one army every fifty turns, including cities and generals. Normal speed is 0.5 seconds per turn, giving one-second and twenty-five-second production intervals. Room speed changes elapsed time. City-State (modifier 1) creates an adjacent free city with initial army `-1`; that visible value is separate from an unknown army count.

The package ships its own viewer renderer and inline SVG terrain symbols. Its default color mapping follows the Bot Server palette. It does not ship the remote game client, third-party bot repositories, downloaded articles or match logs.

## Strategy research

The S1 design was informed by public discussions of gathering, movement budgets, defense deadlines and transport. These references document ideas studied; their authors' rankings and win rates are not measurements of this agent.

- [Human.exe / EklipZ_ai](https://github.com/EklipZgit/generals-bot): gathering trees, action ordering, timed defense and interception.
- [zzd_bot 2](https://github.com/zzd233/generals.io-zzd_bot-2-release-version): economic inference, target evaluation and defense.
- [Szpadel generalsAI](https://github.com/Szpadel/generalsAI): task priorities, route evaluation and replanning after each step.
- [Harris generals-bot](https://github.com/harrischristiansen/generals-bot): transport routes and collecting troops into a main force.
- [Artificial Generals Intelligence](https://arxiv.org/abs/2507.06825) and [generals-bots](https://github.com/strakam/generals-bots): alternative learning methods, simulation and repeatable opponents. This package uses a rule-and-search policy and contains no trained policy weights.

The environment prompt's introductory advice combines general player experience with these articles. It presents conditional advice, with no fixed score ratio or distance as a universal win/loss rule:

- [generals.io 入坑手册](https://www.luogu.com/article/ca5xh4lh)
- [generals.io 战术论](https://zhuanlan.zhihu.com/p/510274199)
- [Generals 攻略](https://www.luogu.com/article/7eg3y9xf)
- [gernerals 小技巧](https://zhuanlan.zhihu.com/p/553110152)
- [generals.io 新手攻略](https://www.cnblogs.com/LightningCreeper/p/18211732)

The implementation and documentation are distributed under the repository's [MIT license](../LICENSE). References retain their own authorship and terms; linking them does not relicense their contents.
