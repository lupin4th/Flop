# FLOP 에이전트 런북 (devnet 리허설 기준)

2026-11-20에 devnet에서 실제로 실행해 확인한 내용만 적었습니다. 테스트넷이 열리면 `--network devnet`을 `--network testnet`으로 바꿔 같은 순서로 진행하되, 그때 공개되는 공식 온보딩 문서를 먼저 확인하세요.

> devnet FLOP은 가치가 없고 에어드랍 점수에 들어가지 않습니다. 에어드랍은 테스트넷에서만 적립됩니다.

## 확인된 것

| 단계 | 상태 | 비고 |
|---|---|---|
| 공식 CLI 설치 | 됨 | `@flop-labs/cli@0.7.1`, Node 22 이상 필요 |
| 에이전트 지갑 생성 | 됨 | `sr25519`, 암호화된 키 파일 |
| 파우셋 | 됨 | 일반 경로 25 FLOP, 주소당 24시간 1회 |
| 추론 구매(정산 세션) | **막힘** | 아래 "막힌 지점" 참고 |

## 1. CLI 설치

설치 스크립트를 끄고 버전을 고정해 별도 폴더에 설치합니다.

```bash
mkdir -p ~/.local/share/flop-cli-0.7.1 && cd ~/.local/share/flop-cli-0.7.1
npm install --ignore-scripts --save-exact @flop-labs/cli@0.7.1
```

기본 Node가 22 미만이면 Node 22로 직접 실행합니다.

```bash
~/.nvm/versions/node/v22.23.1/bin/node ~/.local/share/flop-cli-0.7.1/node_modules/@flop-labs/cli/dist/cli.js --version
```

아래에서는 이 실행 명령을 `flop`으로 줄여 씁니다.

## 2. 지갑 생성

비밀번호는 환경 변수로만 전달됩니다. 반드시 본인 터미널에서 직접 입력하세요.

```bash
read -s "FLOP_KEY_PASSWORD?지갑 비밀번호: "; export FLOP_KEY_PASSWORD
flop keys generate --type sr25519 --name my-agent --out ~/.flop-wallet/agent.json --password-env FLOP_KEY_PASSWORD
flop keys inspect ~/.flop-wallet/agent.json
```

- 시드 문구는 출력되지 않습니다. 키 파일과 비밀번호가 유일한 복구 수단입니다.
- Technocore DID 키(ed25519)와는 별개의 지갑입니다. DID 키를 다른 도구에 넣지 마세요.

## 3. 파우셋

```bash
flop --network devnet network status
flop --network devnet faucet request <주소>
flop --network devnet balance <주소>
```

- **일반 경로를 먼저 쓰세요.** 에이전트/채팅 경로로 먼저 받은 주소는 이후 모든 경로에서 2 FLOP 규칙에 묶입니다.
- 응답이 `"status": "unconfirmed"`여도 다시 요청하지 말고 잔액을 확인하세요. 실제로는 몇 초 안에 입금됐습니다.
- 거절 응답을 반복 재시도하지 마세요. `retryAfterSeconds`를 따릅니다.
- devnet RPC는 연결이 자주 10초 타임아웃으로 실패합니다. `RPC unreachable`이면 같은 명령을 다시 실행하면 됩니다(파우셋 요청은 예외: 먼저 잔액 확인).

## 4. 추론 구매 — 막힌 지점

인덱서는 에이전트 지출을 **정산된 컴퓨트 채널** 기준으로 집계합니다(`inferenceSpend`: `totalSpentRaw`, `channelCount`, `settledChannels`). 그 채널을 여는 명령은 다음입니다.

```bash
flop --network devnet --keystore ~/.flop-wallet/agent.json --password-env FLOP_KEY_PASSWORD \
  session run --miner <마이너 주소> --model <모델 슬러그> \
  --prompt 'Say hello.' --max-flop 0.05 --via auto --endpoint <마이너 HTTPS 주소> --json
```

2026-11-20 기준 외부 에이전트는 이 명령을 실행할 수 없습니다.

- `--endpoint`는 마이너가 선택적으로 공개하는 HTTPS 주소인데, 익스플로러의 마이너 목록·세션 오퍼·인덱서·Technocore 방 어디에도 공개된 주소가 없습니다.
- 접속 주소가 필요 없는 `flop chat`은 `--tee-requirements` 없이는 실행 자체를 거부합니다.
- 게이트웨이 키(`agent credential`)는 동작하지만 공식 문서상 "브로커 자금"을 쓰므로 본인 지갑의 지출로 잡히지 않습니다.

devnet에서 정산되는 채널은 대부분 0.05 FLOP 에스크로이며, 마이너 운영자가 자기 호스트에서 돌리는 시험으로 보입니다.

## 테스트넷이 열리면 확인할 것

1. 공개 에이전트가 마이너에 접속하는 방법(공개 접속 주소 목록, 또는 게이트웨이 경유 시 본인 지갑 지출로 집계되는지).
2. DID와 지갑을 연결하는 방법, 그리고 테스트넷 파우셋의 DID 조건.
3. 최소 활동 기준과 스냅샷 블록.
4. "독립 수요만 인정": 본인이 운영하는 마이너에서 구매하지 마세요. 정산 기록에 `selfTrade` 항목이 있습니다.

## 읽기 전용 확인 수단 (키 불필요)

- 체인 정보: `https://faucet.flop.network/chain`, 한도: `https://faucet.flop.network/limits`
- 익스플로러 API: `https://explorer.devnet.flop.network/api/miners`, `/api/session-offers`, `/api/health`
- 읽기 전용 MCP: `https://mcp.flop.network/mcp` (`flop_list_settlements`, `flop_get_balance`, `flop_indexer_query` 등)
