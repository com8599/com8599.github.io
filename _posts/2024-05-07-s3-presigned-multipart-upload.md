---
layout: post
title: 숏폼 영상 업로드 — S3 Presigned URL과 멀티파트 업로드(Multipart Upload)
date: 2024-05-07
tags: [infra]
description: 영상 파일을 API 서버를 거치지 않고 S3에 직접 올리기 위해 Presigned PUT·POST와 멀티파트 업로드를 조합하는 방법과 제약 조건을 정리한다.
---

영상 업로드를 API 서버가 받아서 S3로 다시 보내면, 수십~수백 MB의 바이트가 서버 메모리와 네트워크를 그대로 통과한다. 업로드가 몰리면 API 컨테이너의 대역폭과 커넥션이 영상 전송에 묶이고, 업로드 중 배포가 일어나면 전송이 끊긴다. 일반적인 해법은 서버는 **업로드 권한만 발급**하고 바이트는 클라이언트가 **S3로 직접** 보내게 하는 것이다. 이 글은 그 권한 발급 수단인 Presigned URL과, 큰 파일을 나눠 올리는 멀티파트 업로드를 다룬다. 업로드된 객체의 `Content-Type` 같은 메타데이터 처리는 [S3 객체 메타데이터와 Content-Type](/2022/03/08/s3-object-metadata/)에서 다뤘다.

## Presigned URL의 원리

Presigned URL은 특정 S3 작업(버킷, 키, HTTP 메서드)에 대한 서명을 쿼리 문자열에 담은 URL이다. 서명은 URL을 만든 IAM 주체의 자격 증명으로 계산되므로, URL을 가진 사람은 AWS 자격 증명 없이도 그 주체의 권한 범위 안에서 그 작업 하나를 수행할 수 있다. 서명은 서버에서 로컬로 계산되며 S3에 요청을 보내지 않는다.

유효 시간에는 두 가지 상한이 있다.

| 서명한 자격 증명 | 최대 유효 시간 |
|---|---|
| IAM 사용자 (SigV4) | 7일 |
| IAM 역할 (ECS 태스크 역할, AssumeRole 등) | 역할 세션이 끝나면 URL도 만료. 지정한 만료 시간이 더 길어도 마찬가지 |
| EC2 인스턴스 프로파일 | 역할 자격 증명의 유효 기간 (보통 최대 6시간 정도) |
| S3 콘솔에서 생성 | 1분~12시간 |

ECS 태스크 역할로 서명한다면 URL 만료를 몇 시간 단위로 잡아도 그 전에 만료될 수 있다. 업로드용 URL은 보통 수 분~수십 분이면 충분하므로 짧게 발급하고, 필요하면 다시 발급받게 한다. S3는 만료를 요청이 **시작되는 시점**에 확인하므로, 만료 직전에 시작한 업로드는 전송 도중 만료 시간이 지나도 계속된다.

Presigned URL은 일종의 소지자 토큰(bearer token)이다. 유출되면 만료 전까지 누구나 쓸 수 있으므로 로그에 남기지 않고, 키는 서버가 정한다.

## PUT과 POST 정책

단일 요청 업로드에는 두 가지 방식이 있다.

| 항목 | Presigned PUT | Presigned POST (POST 정책) |
|---|---|---|
| 요청 형식 | `PUT` + 파일 바이트가 그대로 본문 | `multipart/form-data` 폼, 정책·서명 필드 + 파일 |
| 서명 대상 | 메서드, 버킷, 키, 서명에 포함된 헤더 | Base64로 인코딩한 정책 문서 |
| 파일 크기 제한 | 서명으로 범위를 강제하기 어려움 | `content-length-range` 조건으로 최소·최대 바이트 강제 |
| 키 제한 | 정확한 키 하나 | `starts-with` 조건으로 접두사 허용 가능 |
| 클라이언트 구현 | 가장 단순 (`fetch`, `Dio.put`) | 폼 필드를 순서대로 구성해야 함 |
| 대용량 | 단일 PUT 한도는 5 GB, 끊기면 처음부터 다시 | 역시 단일 요청이라 재개 불가 |

POST 정책은 만료 시간과 조건 목록으로 이루어진 JSON 문서다. AWS SDK for JavaScript v3에서는 `@aws-sdk/s3-presigned-post`로 만든다.

```typescript
import { S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";

const s3 = new S3Client({ region: "ap-northeast-2" });

export async function createThumbnailUpload(userId: string, uploadId: string) {
  return createPresignedPost(s3, {
    Bucket: "media-upload",
    Key: `raw/${userId}/${uploadId}.jpg`,
    Conditions: [
      ["content-length-range", 1, 5 * 1024 * 1024],
      ["eq", "$Content-Type", "image/jpeg"],
    ],
    Fields: { "Content-Type": "image/jpeg" },
    Expires: 600,
  });
}
```

`Conditions`에 적은 값은 `Fields`에도 넣어야 응답 필드에 포함된다. SDK가 조건을 보고 필드를 자동으로 채워 주지 않는다. `Expires`의 기본값은 3600초다.

크기를 강제할 수 있다는 점에서 POST가 더 안전하지만, 영상처럼 큰 파일은 어차피 멀티파트 업로드로 가야 하고 멀티파트 업로드에는 POST 정책이 없다. 따라서 썸네일처럼 작은 파일은 POST, 영상은 멀티파트로 나누는 구성이 자연스럽다.

## 멀티파트 업로드

멀티파트 업로드는 객체 하나를 여러 파트(part)로 나눠 올린 뒤 S3가 합치게 하는 방식이다. AWS는 객체가 100 MB 정도에 이르면 멀티파트 업로드를 고려하라고 권한다.

| 항목 | 제한 |
|---|---|
| 최대 객체 크기 | 5 TiB |
| 업로드당 최대 파트 수 | 10,000 |
| 파트 번호 | 1~10,000 |
| 파트 크기 | 5 MiB~5 GiB (마지막 파트는 최소 크기 제한 없음) |

모바일 네트워크에서의 장점이 크다.

- 실패한 파트만 다시 보내면 된다. 단일 PUT은 90%에서 끊기면 처음부터 다시 올려야 한다.
- 파트를 병렬로 보내 처리량을 높일 수 있다.
- 업로드 진행률을 파트 단위로 정확하게 보여 줄 수 있다.

흐름은 세 단계다.

1. **CreateMultipartUpload**: 서버가 업로드를 시작하고 `UploadId`를 받는다.
2. **UploadPart**: 파트마다 `PUT`으로 바이트를 보내고, 응답 헤더의 `ETag`를 기록한다. 같은 파트 번호로 다시 올리면 이전 파트를 덮어쓴다.
3. **CompleteMultipartUpload**: 파트 번호와 `ETag` 목록을 보내면 S3가 파트 번호 오름차순으로 이어 붙여 객체를 만든다.

클라이언트가 2단계를 직접 하려면 각 `UploadPart` 요청에 대한 Presigned URL이 필요하다. 1·3단계는 서버가 자기 자격 증명으로 직접 호출한다.

## 서버 구현

```typescript
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: "ap-northeast-2" });
const BUCKET = "media-upload";
const PART_SIZE = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

export async function startVideoUpload(userId: string, uploadId: string, size: number) {
  if (size <= 0 || size > MAX_VIDEO_BYTES) {
    throw new Error("invalid size");
  }
  const key = `raw/${userId}/${uploadId}.mp4`;
  const created = await s3.send(
    new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key, ContentType: "video/mp4" }),
  );

  const partCount = Math.ceil(size / PART_SIZE);
  const urls = await Promise.all(
    Array.from({ length: partCount }, (_, i) =>
      getSignedUrl(
        s3,
        new UploadPartCommand({
          Bucket: BUCKET,
          Key: key,
          UploadId: created.UploadId,
          PartNumber: i + 1,
        }),
        { expiresIn: 900 },
      ),
    ),
  );

  return { key, s3UploadId: created.UploadId, partSize: PART_SIZE, urls };
}

export async function completeVideoUpload(
  key: string,
  s3UploadId: string,
  parts: { partNumber: number; etag: string }[],
) {
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  return s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: BUCKET,
      Key: key,
      UploadId: s3UploadId,
      MultipartUpload: {
        Parts: sorted.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    }),
  );
}

export async function abortVideoUpload(key: string, s3UploadId: string) {
  await s3.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: key, UploadId: s3UploadId }));
}
```

설계 포인트는 다음과 같다.

- **키는 서버가 만든다.** 클라이언트가 보낸 파일 이름을 키로 쓰지 않는다. 다른 사용자의 경로를 덮어쓰거나 예측 가능한 키가 생기는 것을 막는다.
- **크기 상한은 서버가 검사한다.** 멀티파트에는 POST 정책 같은 크기 조건이 없으므로, 발급하는 파트 URL 개수(`partCount × PART_SIZE`)로 사실상의 상한을 건다. 업로드 완료 후 `HeadObject`로 실제 크기를 다시 확인한다.
- **파트 크기는 최소 5 MiB.** 마지막 파트를 제외한 파트가 5 MiB보다 작으면 완료 단계에서 `EntityTooSmall` 오류가 난다. 10,000개 제한 때문에 10 MiB 파트로는 약 97 GiB까지 올릴 수 있으므로 숏폼 영상에는 충분하다.
- **Complete의 파트 목록은 오름차순.** 순서가 틀리면 `InvalidPartOrder` 오류가 난다.
- **업로드 상태를 저장한다.** `key`, `s3UploadId`, 사용자, 시작 시각을 DB에 남겨야 재시도, 완료 처리, 정리를 할 수 있다.

`CompleteMultipartUpload`는 처리에 몇 분이 걸릴 수 있고, S3가 먼저 `200 OK`를 보낸 뒤에 오류가 날 수 있다. SDK는 응답 본문에 포함된 오류를 감지해 예외로 바꿔 주므로 SDK를 쓰는 편이 안전하다.

## 클라이언트와 ETag, CORS

클라이언트는 받은 URL에 파일 조각을 `PUT`으로 보내고 응답의 `ETag` 헤더를 모아 서버의 완료 API에 전달한다.

```typescript
async function uploadParts(file: Blob, partSize: number, urls: string[]) {
  const parts: { partNumber: number; etag: string }[] = [];
  for (let i = 0; i < urls.length; i++) {
    const chunk = file.slice(i * partSize, (i + 1) * partSize);
    const res = await fetch(urls[i], { method: "PUT", body: chunk });
    if (!res.ok) throw new Error(`part ${i + 1} failed: ${res.status}`);
    const etag = res.headers.get("ETag");
    if (!etag) throw new Error("ETag not exposed. Check bucket CORS ExposeHeaders.");
    parts.push({ partNumber: i + 1, etag });
  }
  return parts;
}
```

브라우저에서 실행되는 웹 클라이언트라면 여기서 대부분 한 번 막힌다. `ETag`는 CORS에서 기본으로 노출되는 응답 헤더가 아니므로, 버킷 CORS 설정의 `ExposeHeaders`에 넣지 않으면 JavaScript가 값을 읽을 수 없어 `null`이 된다.

```json
[
  {
    "AllowedOrigins": ["https://admin.example.com"],
    "AllowedMethods": ["PUT", "POST"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

CORS는 브라우저가 적용하는 규칙이므로 Flutter 같은 네이티브 앱의 HTTP 클라이언트에는 해당하지 않는다. 앱과 웹 관리 도구가 같은 업로드 API를 쓴다면 웹 쪽을 위해 설정해 둔다. 예시처럼 순차 업로드면 구현이 단순하고, 동시성을 3~4 정도로 제한해 병렬로 보내면 처리량이 올라간다. 실패한 파트는 같은 파트 번호로 다시 올리면 되고, URL이 만료되었다면 해당 파트 번호의 URL만 재발급한다.

## 미완료 업로드 정리

완료도 중단도 되지 않은 멀티파트 업로드의 파트는 객체 목록에 보이지 않지만 저장 공간을 차지하고 과금된다. 앱이 업로드 도중 종료되는 일은 흔하므로 버킷 수명 주기 규칙으로 자동 정리한다.

```json
{
  "Rules": [
    {
      "ID": "abort-incomplete-mpu",
      "Status": "Enabled",
      "Filter": { "Prefix": "raw/" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    }
  ]
}
```

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket media-upload \
  --lifecycle-configuration file://lifecycle.json
```

시작 후 지정한 일수 안에 완료되지 않은 업로드는 중단 대상이 되고, S3가 업로드를 중단하며 파트를 삭제한다. 이 규칙은 기존 업로드와 이후 업로드 모두에 적용되고, 완료된 객체는 지우지 않는다. 서버 쪽에서도 사용자가 업로드를 취소하면 즉시 `AbortMultipartUpload`를 호출해 정리한다.

## 정리

1. API 서버는 업로드 권한만 발급하고, 영상 바이트는 Presigned URL로 클라이언트가 S3에 직접 보낸다.
2. Presigned URL은 서명한 자격 증명보다 오래 살 수 없다. IAM 사용자는 최대 7일, 역할 자격 증명은 세션이 끝나면 함께 만료되므로 업로드 URL은 짧게 발급한다.
3. 작은 파일은 `content-length-range`로 크기를 강제할 수 있는 POST 정책이, 큰 영상은 멀티파트 업로드가 적합하다.
4. 멀티파트는 파트 5 MiB~5 GiB(마지막 제외), 최대 10,000개이며, 파트별 Presigned `UploadPart` URL을 발급하고 `ETag`를 모아 오름차순으로 `CompleteMultipartUpload`를 호출한다.
5. 웹 클라이언트가 `ETag`를 읽으려면 버킷 CORS의 `ExposeHeaders`에 `ETag`를 넣어야 한다.
6. `AbortIncompleteMultipartUpload` 수명 주기 규칙으로 중단된 업로드의 파트가 계속 과금되지 않게 한다.
