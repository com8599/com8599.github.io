---
layout: post
title: S3 객체 메타데이터와 Content-Type
date: 2022-03-08
tags: [infra, spring-boot]
description: 브라우저가 파일을 보여 줄지 내려받을지는 S3에 저장된 메타데이터가 결정한다.
---

S3 URL을 열었을 때 이미지가 표시되지 않고 다운로드된다면 원인은 대부분 객체의 `Content-Type`이다. S3는 업로드 시 받은 메타데이터를 그대로 응답 헤더로 돌려준다.

## 브라우저 동작을 결정하는 헤더

| 헤더 | 의미 |
|---|---|
| `Content-Type` | 리소스 형식. `image/png`면 표시, `application/octet-stream`이면 다운로드 |
| `Content-Disposition` | `inline` 또는 `attachment; filename="..."` |
| `Cache-Control` | CDN, 브라우저 캐시 정책 |

## SDK가 Content-Type을 정하는 방식 (AWS SDK for Java v1)

- `putObject(bucket, key, File)`: 파일 확장자로 MIME 타입을 추정한다.
- `putObject(bucket, key, InputStream, ObjectMetadata)`: 스트림에서는 타입을 추정하지 않는다. `ObjectMetadata`에 지정하지 않으면 SDK가 `application/octet-stream`으로 채워 보낸다.

```java
ObjectMetadata metadata = new ObjectMetadata();
metadata.setContentType(file.getContentType());
metadata.setContentLength(file.getSize());
s3.putObject(bucket, key, file.getInputStream(), metadata);
```

`Content-Length`를 지정하지 않으면 SDK v1은 길이를 알기 위해 스트림 전체를 메모리에 버퍼링하고 `No content length specified for stream data` 경고를 남긴다. 큰 파일에서는 메모리 문제가 된다.

SDK v2에서는 요청 객체에 직접 지정한다. 길이는 `RequestBody.fromInputStream(InputStream, long)`의 두 번째 인자로 넘긴다.

```java
PutObjectRequest request = PutObjectRequest.builder()
        .bucket(bucket)
        .key(key)
        .contentType(file.getContentType())
        .build();
s3.putObject(request, RequestBody.fromInputStream(file.getInputStream(), file.getSize()));
```

## 이미 저장된 객체의 메타데이터 수정

업로드 후에는 객체의 메타데이터를 직접 수정할 수 없다. 메타데이터만 바꾸려면 같은 키로 복사하면서 메타데이터를 교체한다.

```bash
aws s3 cp s3://bucket/path/ s3://bucket/path/ --recursive \
  --exclude "*" --include "*.png" \
  --metadata-directive REPLACE --content-type image/png
```

`REPLACE`는 기존 메타데이터를 복사하지 않고 명령에 지정한 값으로 대체한다. `Cache-Control`, `Content-Disposition`, 사용자 정의 메타데이터(`x-amz-meta-*`)를 유지해야 한다면 같은 명령에 함께 지정한다. `--recursive`로 접두사 전체를 처리할 때는 `--exclude`/`--include`로 대상 확장자를 제한해야 다른 형식의 객체까지 `image/png`로 바뀌지 않는다.

## 업로드 파일의 보안 고려

- 클라이언트가 보낸 `Content-Type`은 신뢰할 수 없다. Apache Tika 등으로 실제 바이트를 검사해 허용 목록과 비교한다.
- `text/html`, `image/svg+xml`을 그대로 `inline`으로 서빙하면 저장형 XSS가 될 수 있다. 사용자 업로드는 서비스와 다른 도메인(CDN 도메인)에서 제공한다.
- 응답에 `X-Content-Type-Options: nosniff`를 붙여 브라우저의 타입 추측을 막는다. 이 헤더는 S3 객체 메타데이터로 설정할 수 있는 항목이 아니므로, CloudFront 응답 헤더 정책처럼 앞단에서 붙인다.
