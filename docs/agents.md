# Agents

## Where an agent runs

The rule, which the console enforces and the database repeats as a constraint:

| The agent answers | It may run | Who vouches for it |
|---|---|---|
| One member | in that member's Buzz app, **or** hosted here | the member |
| Several chosen members | hosted here | the community |
| Every member | hosted here | the community |

An agent in a member's Buzz app needs nothing from this repository. The member creates it in the app; it runs while the app is open and answers only them. The console lists such agents under *Agents → In members' apps* once they have connected.

Hosting is for the two cases the app cannot cover: a personal agent that should stay online when its owner's laptop is closed, and an agent more than one person uses. Buzz's own agents answer only their owner by design, so anything shared has to be hosted.

## Hosting a personal agent

1. Console → Agents → *Host an agent* → **One member**, choose the owner, name it, choose a model.
2. The console creates the agent's key and shows its public key. Send that to the owner.
3. In Buzz, the owner opens *Settings → Security → Authorize external identity*, pastes the key, and sends back the authorization Buzz gives them.
4. Paste the authorization into the console. The agent starts.

The authorization is the owner's signature saying "this key acts for me". Without it the agent does not start: the console never signs as a member.

A hosted personal agent opens a direct conversation with its owner the first time it starts, which is where the owner finds it.

## Hosting a shared agent

Console → Agents → *Host an agent* → **Chosen members** or **Every member**. It starts at once.

For a shared agent the console creates a second key, a custodian, that exists only to vouch for that one agent. No member's identity stands behind what other people ask it to do, and two shared agents are not treated as siblings that trust each other.

Members talk to a shared agent by mentioning it in a channel it is in. Any member can add a shared agent to a channel; only its owner can add a personal one. A shared agent does not answer direct messages from anyone but its custodian, which is a limit of the upstream agent runner.

## What runs

The `hive` service is one container. A small supervisor (`apps/hive`) keeps one upstream `buzz-acp` process per agent, each with the upstream `buzz-agent` model runtime and its tools:

- It polls the console every 15 seconds for the set of agents that should be running, starts what is missing, restarts what changed, stops what was removed.
- An agent that exits is started again after 2, 4, 8 … seconds, up to 5 minutes. After six exits in a row it is reported as *Failed to start* and retried every 10 minutes. The reason is shown in the console next to the status.
- If the console is unreachable, running agents keep running.
- On a deploy, each agent gets up to 65 seconds to finish the turn it is in.

Agent memory lives on the relay, so it survives restarts. Files an agent wrote in its home directory do not: the container has no volume.

## Models

Set at least one key on the `hive` service (`AGENTS.md`, step 8):

| Provider | Variable | Notes |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | The console suggests current Claude models; any model id can be typed. |
| OpenAI-compatible | `OPENAI_API_KEY`, optionally `OPENAI_BASE_URL` | Any endpoint that speaks the Chat Completions or Responses API. |
| OpenRouter | `OPENROUTER_API_KEY` | |

Agents never receive these keys. Each agent process is given a token that only a proxy inside the container accepts; the proxy checks that the token belongs to a running agent, that the request is an inference call for that agent's provider, and then forwards it with the real key. See `docs/security.md` for what else separates agents from each other.

## Limits to know about

- No complete agent conversation has been tested against this deployment, because no model key was available when it was built. What is tested: the host starts an agent, the agent authenticates to the relay as itself with its owner's authorization, publishes its profile and shows as online.
- Upstream describes Buzz 1.0 and the headless runner as compatible at the protocol level and does not claim an end-to-end test either.
- Messages sent while an agent was down are not replayed to it when it comes back.
