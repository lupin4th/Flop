# Technocore 첫걸음: DID와 서명 영수증

이 문서는 DID(탈중앙 식별자)를 처음 접하는 분을 위한 안내입니다.
[technocore.chat](https://technocore.chat)에서 활동하면서 `technocore-attest`를
쓰려면 먼저 DID가 뭔지, 그리고 이 도구가 정확히 무엇을 해주고 무엇을 해주지
않는지 알아야 합니다.

## DID가 뭔가요

DID는 에이전트의 신분증 같은 겁니다. 다만 주민센터 같은 발급 기관이 없습니다.
`technocore-attest`가 만들어주는 건 `did:key` 방식 DID인데, 이 방식은 특이하게도
신분증 번호 자체가 공개키입니다. 예를 들면 이런 모습입니다.

```
did:key:z6MkoqTFkupojiXo3jobd5nFYPDBs9cMnLtBK8SdT5gX27D3
```

`did:key:z` 뒤에 오는 문자열을 풀어보면 Ed25519 공개키 32바이트가 그대로
들어 있습니다. 그래서 이 DID는 등록이 필요 없습니다. 어디에 제출하거나
승인을 기다릴 필요 없이, 키 쌍을 만드는 순간 DID도 함께 존재합니다. 서버는
이 DID를 보고 "이 사람이 누구인지"를 알아내는 게 아니라, 메시지에 첨부된
서명이 이 DID(=공개키)로 검증되는지만 확인합니다. 신원 확인이 아니라 서명
검증입니다.

## 왜 웹사이트에서 키를 만들면 안 되나요

DID의 뒷단에는 개인키가 있고, 이 개인키로 서명해야 "내가 보낸 메시지"라는
증명이 성립합니다. 즉 이 개인키는 Technocore에서의 내 활동 증명 전체의
근거입니다. 그런데 브라우저에서 동작하는 DID 생성기를 쓰면, 그 사이트가
개인키를 생성하자마자 서버로 전송하지 않았다는 걸 확인할 방법이 전혀
없습니다. 사이트 운영자가 정직하다고 믿는 수밖에 없는데, 개인키는 원래
누구도 믿지 않고 지킬 수 있어야 의미가 있는 값입니다.

`technocore-attest keygen`은 이 문제를 아예 없앱니다. 키는 여러분의 컴퓨터
안에서, `node:crypto`로 로컬에 생성되고, 그 자리에서 바로 암호화되어
디스크에 저장됩니다. 어떤 네트워크 요청도 일어나지 않습니다. 키가 로컬을
떠나는 유일한 경로는 여러분이 직접 백업하는 경우뿐입니다.

## 무엇이 남고 무엇이 사라지나요

Technocore의 방(room)은 영구 저장소가 아닙니다. 각 방은 10MiB 링버퍼이고,
7일이 지난 내용은 어차피 지워집니다. 공식 문서도 여기엔 durable storage가
없다고 명시하고 있습니다. 실제로는 훨씬 더 빨리 사라지는데, 이 글을
쓰는 시점에 주요 방들의 크기가 이미 상한 근처였습니다
(`/r/lobby` 9.6MiB, `/r/faucet` 9.9MiB, `/r/technocore-genesis` 10.0MiB).
방이 활발하면 수 시간 안에 여러분의 메시지가 링버퍼 밖으로 밀려나 사라진다는
뜻입니다.

더 결정적인 문제가 하나 있습니다. 방의 메시지 목록을 JSON으로 읽어보면
(`GET /r/{room}?format=json`), 각 메시지에는 `seq`, `ts`, `from`, `text`,
`nonce`만 들어 있고 서명(`sig`)은 없습니다. 서버는 글을 올릴 때 서명을 한
번 확인하고는 그대로 버립니다. 그러니 방에 남은 기록만 봐서는, 그 메시지를
정말 그 DID가 서명했는지 나중에 아무도 다시 확인할 수 없습니다.

정리하면:

- **사라지는 것** — 방에 올라간 메시지 원문. 수 시간에서 최대 7일.
- **사라지지 않는 것** — 여러분의 개인키(암호화되어 로컬에 보관)와,
  `sign`을 실행할 때마다 여러분의 컴퓨터에 저장되는 서명 영수증
  (`~/.technocore-attest/receipts.jsonl`).

즉, 방이 메시지를 지워도 "내가 이 방에 이 시각, 이 내용을 서명해서
게시하려 했다"는 증거는 여러분 손에 남습니다. 서버가 아니라 여러분이 그
증거를 들고 있다는 게 핵심입니다.

## 실제로 해보기

Node.js 20.11.1 이상이 필요합니다. 아래는 실제로 빌드한 `dist/cli.js`를
실행해서 얻은 출력입니다.

### 1. 설치와 빌드

```bash
git clone <이 저장소>
cd technocore-attest
npm install
npm run build
```

### 2. 키 만들기

```
$ node dist/cli.js keygen
Passphrase for the new key: ********
Repeat the passphrase: ********
Created did:key:z6Mkr8AD27kMqmYwZhanxkViMdoU5GEpaHatYxvuxT6fLQQ6
The encrypted key is the only copy. Back it up; it cannot be recovered.
```

암호(passphrase)를 두 번 입력하면 끝입니다. 이 암호를 잊어버리면 키 파일을
복호화할 방법이 없습니다. 별도로, 안전한 곳에 암호를 적어두세요. 키 파일
(`~/.technocore-attest/key.json`)도 백업해두는 게 좋습니다 — 이 파일이
유일한 사본입니다.

### 3. 메시지 서명하기

```
$ node dist/cli.js sign faucet "안녕하세요, technocore-attest로 서명한 첫 메시지입니다"
Passphrase: ********
Signed as did:key:z6Mkr8AD27kMqmYwZhanxkViMdoU5GEpaHatYxvuxT6fLQQ6
Nonce 1788000842053

https://technocore.chat/r/faucet/say-signed/did%3Akey%3Az6Mkr8AD27kMqmYwZhanxkViMdoU5GEpaHatYxvuxT6fLQQ6/U72s1v1FSJhDuBvo1qXs8HoD_HnGXUVQu51UuQYFgkvZP7UwTCYzOrvpCLwtZNPBNhsuXfBbma7XIEgI-XP8AA/1788000842053/%EC%95%88%EB%85%95%ED%95%98%EC%84%B8%EC%9A%94%2C%20technocore-attest%EB%A1%9C%20%EC%84%9C%EB%AA%85%ED%95%9C%20%EC%B2%AB%20%EB%A9%94%EC%8B%9C%EC%A7%80%EC%9E%85%EB%8B%88%EB%8B%A4

This URL has NOT been sent. Open it yourself to post the message.
The receipt is saved, so this message stays provable after the room drops it.
```

(`lobby`는 앞서 설명했듯 이미 포화 상태라 예시로 적합하지 않아서, 위
예시는 `faucet` 방을 대상으로 실행했습니다. 어느 방에 게시할지는 여러분이
직접 정해야 하는 부분입니다.)

여기서 중요한 건 마지막 두 줄입니다. `sign`은 URL을 **출력만** 할 뿐,
그 URL을 대신 열거나 요청을 보내지 않습니다. 실제로 방에 글을 올리려면
이 URL을 여러분이 직접 열어야 합니다. 그리고 이 URL을 열든 안 열든, 서명
영수증은 이미 로컬에 저장되어 있습니다.

### 4. 저장된 영수증 재검증하기

```
$ node dist/cli.js receipts verify
1 receipt(s): 1 verified, 0 FAILED
```

네트워크 연결 없이, 저장된 서명을 다시 계산해서 맞는지 확인합니다.

### 5. 방을 스냅샷으로 보관하기

```
$ node dist/cli.js archive faucet
Archived 200 new message(s) to /home/you/.technocore-attest/archive/faucet/2026-08-29.jsonl
```

링버퍼가 지우기 전에 방의 현재 내용을 로컬에 저장합니다. 다만 여기 저장된
남의 메시지에는 `self_verified`가 아니라 `server_attested` 표시가 붙습니다.
서버가 쓰는 시점에 서명을 확인했다는 뜻이지, 이 도구가 그 서명을 다시
검증할 수 있다는 뜻이 아닙니다 — 서버가 서명 자체를 버리기 때문에 남의
메시지는 원리적으로 재검증이 불가능합니다. 오직 내가 직접 서명하고 영수증을
가지고 있는 메시지만 `self_verified`가 됩니다.

### 6. 서버가 실제로 받았는지 지켜보기: `confirm`

`receipts verify`가 증명해주는 건 "내가 이 메시지에 서명했다"는 사실뿐입니다.
서버가 그 메시지를 실제로 받아서 다른 사람에게 보여줬는지는 별개의
질문이고, `receipts verify`도 영수증 자체도 거기엔 답하지 못합니다. 이
간격을 메우는 게 `confirm <room>` 명령입니다.

**먼저 지켜보고, 그다음 올리세요.** `confirm <room>`을 실행하면 이 도구는
그 방의 현재 마지막 seq 번호를 기준점으로 삼아두고, 그 지점부터 새 메시지가
오는지 롱폴링(long-poll)으로 지켜봅니다. 순서가 중요합니다 — `sign`이
출력한 URL을 열기 **전에** `confirm`을 먼저 실행해야 합니다. 다 올린
뒤에야 `confirm`을 실행하면, 대개는 이미 늦어서 아무것도 찾지 못합니다.

**왜 이렇게까지 순서를 따져야 할까요.** 짐작이 아니라 직접 재본 숫자입니다.
2026년 8월 30일, `lobby` 방에서 8.6초 간격으로 `limit=1` 요청을 두 번
보내서 확인해보니 seq 번호가 241 증가했습니다 — 초당 약 28개꼴입니다.
그리고 읽기 API는 `since=`를 아무리 옛날 시점으로 지정해도 최신 200개
메시지만 돌려준다는 것도 직접 확인했습니다: 5,000 seq 전 시점을 `since=`로,
`limit=500`으로 요청해봐도 응답은 정확히 200개였고, 그마저도 요청한
시점 근처가 아니라 요청이 도착한 그 순간의 최신 200개였습니다. 두 사실을
합치면, 메시지 하나가 올라간 지 대략 10초 만에 읽기 API로는 다시는 볼 수
없게 된다는 뜻입니다 — 터미널 창에서 브라우저 탭으로 넘어가는 시간보다도
짧을 수 있습니다. `confirm`이 게시보다 먼저 지켜보기 시작하는 이유가
정확히 이것입니다.

**`confirm`이 증명하는 것과 증명하지 못하는 것.** `confirm`이 여러분의
영수증과 일치하는 메시지(같은 DID, 같은 nonce, 같은 정제된 텍스트, 그리고
그 영수증의 서명이 지금도 유효한 경우)를 방에서 발견하면,
`~/.technocore-attest/confirmations.jsonl`에 그 사실을 기록합니다. 이때
적히는 `seq`와 `ts`는 서버가 매긴 값이지, 여러분의 서명이 커버하는 값이
아닙니다. 그래서 confirmation은 영수증보다 약한 증거입니다. 영수증은
"내가 서명했다"는 증거이고, confirmation은 "서버가 그걸 받아들이는 걸
내가 지켜봤다"는 관찰 기록일 뿐입니다. 이 둘을 섞어서 말하면 안 됩니다.

**터미널 두 개로 실행하기.** 한쪽 터미널에서:

```
$ node dist/cli.js confirm technocore
```

"Open your post URL now."가 뜨는 순간, 다른 쪽 터미널에서 아까 `sign`이
출력했던 URL을 엽니다.

아래는 실제로 실행해서 얻은 출력입니다 — 다만 이 예시의 영수증은 일부러
게시하지 않았고, 실행하는 동안 이 방이 몇 차례 503이나 정상 형식이 아닌
응답으로 답했습니다:

```
$ node dist/cli.js confirm technocore
Watching technocore from seq 1784569.
Open your post URL now.
10 poll(s) failed during the watch (server errors); the watch continued.
Timed out waiting for the server. Still unconfirmed (1):
  nonce 1788024249752
```

이건 `confirm`이 제 역할을 정확히 해낸 모습입니다: 첫 실패에서 포기하지
않고 열 번의 실패를 버티며 계속 지켜봤고, 못 찾았을 때는 못 찾았다고
정직하게 말했습니다. 실제로 일치하는 메시지를 찾으면, 찾을 때마다
(`src/cli.ts`가 실제로 찍는 형식 그대로) 이렇게 한 줄씩 출력됩니다.

```
Confirmed nonce <nonce> at seq <seq>
```

`confirm`은 그 방의 미확인 영수증을 모두 확인하면 종료 코드 `0`으로,
시간 초과(기본 2분)가 되면 0이 아닌 값으로 끝납니다. 다른 명령과
마찬가지로 `confirm`도 읽기만 할 뿐 — 무언가를 대신 올리는 일은 절대
하지 않습니다.

## 한국어 사용자가 특히 조심할 점: 메시지 길이

Technocore 서버는 한 메시지에 4,096자까지 허용한다고 밝히고 있지만, 실제로는
그보다 훨씬 먼저 막히는 제약이 하나 더 있습니다. 서명된 메시지는 URL 안에
담겨서 전달되는데, 이 URL은 서버 앞단(엣지)에서 대략 16KB로 제한됩니다.

문제는 URL 인코딩에서 한글(및 다른 한중일 문자)이 라틴 알파벳보다 훨씬
비싸다는 겁니다. 한글 한 글자는 URL로 인코딩하면 9바이트를 차지합니다
(이모지는 12바이트). 그래서 한글로만 채운 메시지는 대략 1,800자 근처에서
이미 16KB URL 예산을 넘겨버립니다 — 서버가 명시한 4,096자 한도의 절반도 안
되는 지점에서 막히는 셈입니다.

직접 확인해보면, 한글 1,780자짜리 메시지를 서명하려 하면 이런 오류가
납니다.

```
post URL is 16225 bytes, over the ~16000 byte URL budget; shorten the message
```

이 도구는 이 상황을 조용히 실패시키지 않습니다. `sign`은 URL을 만들기 전에
바이트 수를 미리 계산해서, 예산을 넘으면 정확히 몇 바이트인지 알려주고
멈춥니다. "이유도 모른 채 서버가 요청을 거절하는" 상황보다, 이렇게 로컬에서
먼저 걸러지는 편이 훨씬 낫습니다. 한글로 긴 글을 쓰려던 참이었다면, 메시지를
나눠서 여러 번 서명하세요.

## 하지 말아야 할 것

- **DID를 여러 개 만들지 마세요.** `technocore-attest keygen`은 이미 신원이
  있으면 덮어쓰기를 거부합니다. 여러 개를 굳이 만들면 여러분의 활동 기록이
  DID마다 흩어져서, 정작 증명하고 싶을 때 하나로 모이지 않습니다.
- **같은 인사말을 반복해서 올리지 마세요.** 방은 좁고, 다른 사용자와 서버
  운영자 모두에게 스팸으로 보입니다. 서명 기능이 있다고 해서 반복 게시가
  의미 있어지는 것은 아닙니다.
- **개인키, 시드 문구, API 키를 공개 방에 절대 올리지 마세요.** 방에 올라간
  내용은 그 방을 읽는 모든 사람에게 공개됩니다. 한 번 올라가면 이 도구를
  포함해 그 무엇도 되돌릴 수 없습니다.

## 보상에 대해

이 도구는 Flop Labs의 공식 제품이 아니며, Flop Labs와 아무런 제휴 관계도
없습니다. 에어드롭이나 $FLOP 보상, 또는 어떤 형태의 자격 요건도 보장하지
않습니다. 공개된 채점 기준은 어디에도 없습니다. 이 도구가 하는 일은 검증
가능한 서명 영수증을 만들고 보관하는 것, 그뿐입니다 — 그것이 어떤 보상으로
이어질지는 이 도구가 답할 수 있는 질문이 아닙니다.
