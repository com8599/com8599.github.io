---
layout: post
title: 기획 데이터 테이블을 코드로 — 스키마 기반 코드 생성(Code Generation)
date: 2023-05-16
tags: [game-server]
description: 기획 테이블의 구조를 JSON Schema 한 곳에 정의하고 타입, 검증기, 문서를 생성해 어긋남을 빌드 단계에서 잡는 방법.
---

게임 서버는 아이템, 스킬, 퀘스트, 보상 같은 기획 데이터를 대량으로 다룬다. 보통 기획자가 스프레드시트로 관리하고, 빌드나 배포 시점에 CSV나 JSON으로 내보내 서버와 클라이언트가 읽는다. 문제는 이 데이터의 "모양"이 여러 곳에 따로 정의된다는 점이다. 시트의 열 이름, 서버의 타입 정의, 로딩 코드의 파싱 로직, 클라이언트의 모델이 각각 손으로 관리되면 하나가 바뀔 때 나머지가 늦게 따라가고, 그 차이는 대개 런타임 오류나 잘못된 보상으로 드러난다.

이 글은 테이블 구조를 스키마 한 곳에 정의하고, 거기서 타입과 검증 코드와 문서를 생성하는 구성을 다룬다.

## 단일 진실 공급원(Single Source of Truth)

핵심은 테이블 구조의 정의를 한 곳에만 두는 것이다. 나머지는 모두 그 정의에서 파생된 산출물로 취급한다.

| 산출물 | 손으로 관리할 때 | 스키마에서 생성할 때 |
|---|---|---|
| TypeScript 타입 | 시트 열 추가 시 수동 반영 | 스키마 변경 후 재생성 |
| 런타임 검증 | 로더 곳곳의 `if` 문 | 스키마로 컴파일한 검증 함수 |
| 기획자용 문서 | 위키에 따로 작성 | 스키마의 `description`에서 생성 |
| 서버·클라이언트 정합성 | 리뷰에 의존 | 같은 스키마를 공유 |

정의 형식으로는 JSON Schema가 무난하다. 언어 중립적이라 서버와 클라이언트가 다른 언어여도 공유할 수 있고, 검증기와 코드 생성기 생태계가 넓다. 이 글의 예시는 Ajv의 기본 지원 버전인 draft-07을 기준으로 한다.

## 데이터 흐름

파이프라인은 다음 단계로 구성된다.

1. 기획자가 스프레드시트를 수정하고 CSV로 내보낸다.
2. 변환 스크립트가 CSV 행을 JSON 객체로 바꾼다. 이때 숫자, 불리언, 목록 같은 타입 변환이 일어난다.
3. JSON Schema로 모든 행을 검증한다. 실패하면 빌드를 중단한다.
4. 같은 스키마에서 TypeScript 타입과 문서를 생성한다.
5. 서버는 검증을 통과한 JSON과 생성된 타입을 사용한다.

스키마가 바뀌면 4번 산출물이, 데이터가 바뀌면 3번 검증 결과가 달라진다. 둘 다 빌드에서 확인되므로 잘못된 데이터나 어긋난 타입이 배포까지 가지 않는다.

## 스키마 정의

아이템 테이블을 예로 든다.

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "item.schema.json",
  "title": "ItemRow",
  "description": "아이템 테이블의 한 행",
  "type": "object",
  "properties": {
    "id": { "type": "integer", "minimum": 1, "description": "아이템 고유 ID" },
    "name": { "type": "string", "minLength": 1 },
    "grade": { "type": "string", "enum": ["common", "rare", "epic", "legendary"] },
    "price": { "type": "integer", "minimum": 0, "description": "상점 판매가" },
    "stackable": { "type": "boolean" },
    "maxStack": { "type": "integer", "minimum": 1, "maximum": 9999 }
  },
  "required": ["id", "name", "grade", "price", "stackable"],
  "additionalProperties": false
}
```

`additionalProperties: false`가 중요하다. 시트에서 열 이름을 `prcie`로 잘못 적으면 `price` 누락과 알 수 없는 필드 두 가지 오류로 잡힌다. 이 옵션이 없으면 오타 열은 조용히 무시되고 `price`만 빠진 채로 통과할 수 있다.

## 타입 생성 — json-schema-to-typescript

`json-schema-to-typescript`는 JSON Schema를 TypeScript 선언으로 바꾼다. CLI 이름은 `json2ts`이고 파일, 디렉터리, glob 입력을 받는다.

```bash
npx json2ts -i schemas/ -o src/generated/
```

위 스키마에서는 다음과 같은 타입이 나온다.

```ts
/**
 * 아이템 테이블의 한 행
 */
export interface ItemRow {
  /**
   * 아이템 고유 ID
   */
  id: number;
  name: string;
  grade: "common" | "rare" | "epic" | "legendary";
  /**
   * 상점 판매가
   */
  price: number;
  stackable: boolean;
  maxStack?: number;
}
```

`required`에 없는 필드는 선택 속성(`?`)이 되고, `enum`은 문자열 리터럴 유니온이 되며, `description`은 JSDoc 주석으로 옮겨진다. 생성 파일 맨 위에는 기본적으로 "직접 수정하지 말라"는 배너 주석이 붙는다. 프로그래밍 방식으로 쓰려면 `compileFromFile`을 쓴다.

```ts
import { writeFileSync } from "fs";
import { compileFromFile } from "json-schema-to-typescript";

async function main() {
  const ts = await compileFromFile("schemas/item.schema.json", {
    additionalProperties: false,
  });
  writeFileSync("src/generated/item.d.ts", ts);
}

main();
```

`additionalProperties` 옵션은 스키마에 해당 키워드가 명시되지 않았을 때의 기본값이다. 기본값은 `true`라서, 생략된 스키마에서는 `[k: string]: unknown` 인덱스 시그니처가 붙는다.

## 검증 — Ajv

Ajv는 JSON Schema를 JavaScript 함수로 컴파일해 검증한다. 기본 export는 draft-07을 지원하고, draft 2019-09나 2020-12가 필요하면 `ajv/dist/2019`, `ajv/dist/2020`을 import한다.

```ts
import Ajv from "ajv";
import { readFileSync } from "fs";
import type { ItemRow } from "./generated/item";

const ajv = new Ajv({ allErrors: true });
const schema = JSON.parse(readFileSync("schemas/item.schema.json", "utf8"));
const validate = ajv.compile<ItemRow>(schema);

export function validateRows(rows: unknown[]): ItemRow[] {
  const errors: string[] = [];
  rows.forEach((row, index) => {
    if (!validate(row)) {
      for (const e of validate.errors ?? []) {
        errors.push(`row ${index + 2}: ${e.instancePath || "(root)"} ${e.message}`);
      }
    }
  });
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  return rows as ItemRow[];
}
```

몇 가지 동작을 알아 둔다.

- `compile<T>`로 만든 검증 함수는 타입 가드(type guard)다. `validate(row)`가 참인 분기에서 `row`는 `ItemRow`로 좁혀진다.
- `allErrors`의 기본값은 `false`라 첫 오류에서 멈춘다. 기획자에게 한 번에 모든 문제를 보여 주려면 켠다.
- `validate.errors`는 호출할 때마다 덮어쓰이므로 바로 읽어서 옮겨 둔다.
- 오류 메시지의 행 번호는 헤더 행을 고려해 `index + 2`로 계산했다. 기획자가 시트에서 바로 찾을 수 있는 위치를 알려 주는 것이 검증의 실질적인 가치다.

Ajv는 기본적으로 엄격 모드(strict mode)로 동작해, 스키마에 알 수 없는 키워드가 있으면 컴파일 단계에서 실패한다. 시트 열 매핑 정보 같은 자체 메타데이터를 스키마에 넣고 싶다면 `ajv.addKeyword("x-column")`처럼 등록해야 한다. 키워드 오타를 잡아 주는 장치이므로 끄지 않는 편이 낫다.

`format: "email"` 같은 `format` 키워드는 Ajv 본체에 포함되지 않고 `ajv-formats` 패키지를 추가해야 한다.

### 테이블 간 참조 검증

JSON Schema는 한 문서의 구조를 검증할 뿐, "보상 테이블의 `itemId`가 아이템 테이블에 존재하는가" 같은 테이블 간 참조는 표현하지 못한다. 이 검사는 스키마 검증 뒤에 별도 단계로 둔다.

```ts
import type { ItemRow, RewardRow } from "./generated";

export function checkReferences(items: ItemRow[], rewards: RewardRow[]): string[] {
  const itemIds = new Set(items.map((i) => i.id));
  return rewards
    .filter((r) => !itemIds.has(r.itemId))
    .map((r) => `reward ${r.id}: unknown itemId ${r.itemId}`);
}
```

중복 ID 검사도 같은 단계에서 한다. JSON Schema의 `uniqueItems`는 배열 원소 전체가 같은지만 보므로 특정 필드의 유일성 검사에는 맞지 않는다.

## CSV 변환에서 주의할 점

CSV의 모든 값은 문자열이다. 변환 단계에서 타입을 결정하는 방식은 두 가지다.

| 방식 | 장점 | 단점 |
|---|---|---|
| 스키마의 `type`을 보고 변환 | 시트에 타입 정보가 필요 없음 | 변환기가 스키마를 해석해야 함 |
| Ajv `coerceTypes` 옵션 | 구현이 단순 | 변환 규칙이 Ajv에 고정되고, 검증 중에 데이터를 직접 수정함 |

`coerceTypes`는 편하지만 규칙이 시트의 관례와 다를 수 있다. 예를 들어 Ajv는 문자열 중 `"true"`와 `"false"`만 불리언으로 바꾸므로, 시트에서 흔히 쓰는 `TRUE`, `1`, `Y`는 별도 처리가 필요하다. 또 검증 함수가 입력 객체를 그 자리에서 바꾸기 때문에 변환과 검증의 경계가 흐려진다. 스키마의 `type`을 읽어 명시적으로 변환하고, 변환할 수 없는 값은 그대로 문자열로 두어 Ajv가 타입 오류로 잡게 하는 편이 안전하다. 빈 셀을 속성 누락으로 볼지 빈 문자열로 볼지도 변환 규칙에 정해 둔다.

## 문서 생성

`title`, `description`, `enum`, `minimum`, `maximum`은 기획자가 보기에도 필요한 정보다. 스키마를 순회해 마크다운 표를 만들면 위키를 따로 관리할 필요가 없다.

```ts
import { readFileSync } from "fs";

type PropertySchema = {
  type?: string;
  description?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
};

export function renderDoc(path: string): string {
  const schema = JSON.parse(readFileSync(path, "utf8"));
  const required = new Set<string>(schema.required ?? []);
  const lines = [`## ${schema.title}`, "", "| 열 | 타입 | 필수 | 제약 | 설명 |", "|---|---|---|---|---|"];
  for (const [name, p] of Object.entries<PropertySchema>(schema.properties)) {
    const rules = [
      p.enum ? p.enum.join(", ") : "",
      p.minimum !== undefined ? `>= ${p.minimum}` : "",
      p.maximum !== undefined ? `<= ${p.maximum}` : "",
    ].filter(Boolean).join(" / ");
    lines.push(`| ${name} | ${p.type ?? ""} | ${required.has(name) ? "Y" : ""} | ${rules} | ${p.description ?? ""} |`);
  }
  return lines.join("\n");
}
```

## 생성 파일을 커밋할 것인가

생성 파일을 저장소에 커밋하는 방식과 빌드 때마다 생성하는 방식이 있다.

| 방식 | 장점 | 단점 |
|---|---|---|
| 커밋 | 리뷰에서 타입 변경이 보임, IDE가 바로 인식 | 재생성을 잊으면 스키마와 어긋남 |
| 빌드 시 생성 | 항상 최신 | 생성 전에는 타입 오류, 변경 내역이 리뷰에 안 보임 |

커밋 방식을 택했다면 CI에서 "생성 결과가 최신인가"를 검사한다. 생성 스크립트를 다시 돌린 뒤 작업 트리에 변경이 생기면 실패시키는 것이다.

```bash
npm run codegen
git diff --exit-code -- src/generated/ \
  || (echo "generated files are out of date. run: npm run codegen" && exit 1)
```

`git diff --exit-code`는 차이가 있으면 종료 코드 1을 반환한다. 새로 생성된 파일은 추적되지 않아 `git diff`에 잡히지 않으므로, 생성기가 파일을 새로 만들 수 있는 구조라면 `git status --porcelain src/generated/`의 출력이 비어 있는지도 함께 확인한다.

`package.json`에는 생성과 검증을 스크립트로 묶어 둔다.

```json
{
  "scripts": {
    "codegen": "json2ts -i schemas/ -o src/generated/",
    "validate:data": "ts-node scripts/validate-data.ts",
    "build": "npm run codegen && npm run validate:data && tsc"
  }
}
```

## 런타임에서도 검증할 것인가

빌드에서 검증한 데이터는 런타임에 다시 검증할 필요가 없어 보이지만, 운영 중 데이터를 핫 리로드(hot reload)하거나 외부 저장소에서 내려받는 구조라면 로딩 시점에도 같은 검증 함수를 돌린다. 이때는 Ajv의 독립 실행 코드(standalone code) 기능으로 검증 함수를 미리 JavaScript 파일로 생성해 두면, 서버 기동 시 스키마 컴파일 비용이 없어진다. `new Ajv({ code: { source: true } })`로 컴파일한 뒤 `ajv/dist/standalone`의 `standaloneCode(ajv, validate)`로 모듈 코드를 얻거나, `ajv-cli`의 `ajv compile -s schema.json -o validate.js`를 쓴다.

## 정리

- 기획 테이블의 구조는 JSON Schema 한 곳에 정의하고, 타입·검증기·문서는 모두 생성물로 취급한다.
- `json-schema-to-typescript`(`json2ts`)로 타입을, Ajv로 검증 함수를 만든다. `additionalProperties: false`와 `allErrors: true`가 기획 데이터 검증에 특히 유용하다.
- 테이블 간 참조와 필드 유일성은 JSON Schema 밖에서 별도 단계로 검사한다.
- CSV 타입 변환은 `coerceTypes`보다 스키마 기반의 명시적 변환이 안전하다.
- 생성 파일을 커밋한다면 CI에서 재생성 후 `git diff --exit-code`로 최신 여부를 확인한다.
