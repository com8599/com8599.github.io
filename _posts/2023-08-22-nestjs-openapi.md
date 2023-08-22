---
layout: post
title: NestJS에서 OpenAPI(Swagger) 문서 자동화
date: 2023-08-22
tags: [nestjs]
description: "@nestjs/swagger로 문서를 만드는 과정, 데코레이터와 CLI 플러그인의 역할 분담, 매핑 타입, 클라이언트 코드 생성을 위한 JSON 내보내기."
---

OpenAPI는 HTTP API의 경로, 파라미터, 요청·응답 스키마를 기계가 읽을 수 있는 형식으로 기술하는 명세다. Swagger는 이 명세를 다루는 도구 모음(Swagger UI, Swagger Editor 등)의 이름이며, OpenAPI 3.0 이전에는 명세 자체도 Swagger라고 불렸다. NestJS는 `@nestjs/swagger` 패키지로 컨트롤러와 DTO의 메타데이터를 읽어 OpenAPI 3.0 문서를 만든다.

## 문서가 만들어지는 과정

1. 앱이 시작될 때 `SwaggerModule.createDocument()`가 등록된 모듈의 컨트롤러를 탐색(scan)한다.
2. `@Get()`, `@Post()`, `@Param()`, `@Body()` 같은 라우팅 데코레이터에서 경로와 파라미터를 읽는다.
3. DTO 클래스의 속성마다 붙은 `@ApiProperty()` 메타데이터로 스키마를 만든다.
4. `@ApiTags()`, `@ApiResponse()` 등 Swagger 전용 데코레이터로 나머지를 보완한다.
5. `SwaggerModule.setup()`이 결과를 Swagger UI와 JSON·YAML 엔드포인트로 노출한다.

TypeScript의 타입 정보는 런타임에 대부분 사라진다. 데코레이터 메타데이터로 남는 것은 속성의 대략적인 타입 정도이고, 배열의 원소 타입이나 선택 속성(`?`) 여부는 남지 않는다. 그래서 기본적으로는 DTO 속성마다 `@ApiProperty()`를 직접 붙여야 하고, 이 반복을 줄이는 것이 뒤에서 설명할 CLI 플러그인이다.

## 설치와 기본 설정

```bash
npm i @nestjs/swagger
```

NestJS 10에는 `@nestjs/swagger` 7.x를 쓴다.

```ts
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const config = new DocumentBuilder()
    .setTitle('Orders API')
    .setDescription('주문 관리 API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  await app.listen(3000);
}
bootstrap();
```

| 경로 | 내용 |
|---|---|
| `/docs` | Swagger UI |
| `/docs-json` | OpenAPI 문서(JSON) |
| `/docs-yaml` | OpenAPI 문서(YAML) |

JSON·YAML 경로는 `setup()`의 네 번째 인자인 `SwaggerCustomOptions`의 `jsonDocumentUrl`, `yamlDocumentUrl`로 바꿀 수 있다. `createDocument()`의 세 번째 인자 `SwaggerDocumentOptions`로는 문서에 포함할 모듈(`include`), 직접 참조되지 않는 모델(`extraModels`), `operationId` 생성 방식(`operationIdFactory`) 등을 지정한다.

문서 경로는 `app.useGlobalGuards()`나 `APP_GUARD`로 건 Guard의 보호를 받지 않는 일반 경로로 등록된다. 운영 환경에서 공개하지 않으려면 `setup()` 호출 자체를 환경 변수로 감싼다.

## 주요 데코레이터

```ts
@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  @Post()
  @ApiCreatedResponse({ type: OrderDto })
  @ApiBadRequestResponse({ description: '검증 실패' })
  create(@Body() dto: CreateOrderDto): Promise<OrderDto> {
    return this.ordersService.create(dto);
  }

  @Get(':id')
  @ApiOperation({ summary: '주문 단건 조회' })
  @ApiResponse({ status: 200, type: OrderDto })
  @ApiResponse({ status: 404, description: '주문 없음' })
  findOne(@Param('id', ParseIntPipe) id: number): Promise<OrderDto> {
    return this.ordersService.findOne(id);
  }
}
```

| 데코레이터 | 대상 | 역할 |
|---|---|---|
| `@ApiTags()` | 컨트롤러, 메서드 | Swagger UI에서 묶어 보여 줄 태그 |
| `@ApiOperation()` | 메서드 | 요약(`summary`), 설명, `operationId` |
| `@ApiResponse()` | 컨트롤러, 메서드 | 상태 코드별 응답 설명과 스키마 |
| `@ApiOkResponse()` 등 | 컨트롤러, 메서드 | `@ApiResponse()`의 상태 코드별 축약형 |
| `@ApiBearerAuth()` | 컨트롤러, 메서드 | 이 경로가 Bearer 인증을 요구함을 표시 |
| `@ApiProperty()` | DTO 속성 | 스키마 속성(타입, 필수 여부, 예시, enum 등) |
| `@ApiPropertyOptional()` | DTO 속성 | `required: false`인 `@ApiProperty()` |
| `@ApiHideProperty()` | DTO 속성 | 스키마에서 제외 |

`@ApiBearerAuth()`는 `DocumentBuilder`의 `addBearerAuth()`로 보안 스키마(security scheme)를 등록해 두어야 Swagger UI의 Authorize 버튼과 연결된다. 둘 다 이름을 생략하면 `bearer`라는 이름을 공유한다.

## DTO와 @ApiProperty

```ts
export enum OrderStatus {
  PENDING = 'PENDING',
  PAID = 'PAID',
}

export class CreateOrderDto {
  @ApiProperty({ example: 42 })
  @IsInt()
  productId: number;

  @ApiProperty({ minimum: 1, default: 1 })
  @IsInt()
  @Min(1)
  quantity: number = 1;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ enum: OrderStatus, enumName: 'OrderStatus' })
  @IsEnum(OrderStatus)
  status: OrderStatus;
}
```

배열은 `type: [String]`처럼 배열 리터럴로 원소 타입을 알려 줘야 한다. `enumName`을 지정하면 enum이 별도 스키마로 분리되어, 생성된 클라이언트 코드에서도 하나의 타입으로 재사용된다.

## CLI 플러그인

위 DTO는 `class-validator` 데코레이터와 `@ApiProperty()`가 같은 정보를 두 번 적고 있다. `@nestjs/swagger`의 CLI 플러그인은 빌드 시점에 TypeScript 타입 정보를 읽어 이 메타데이터를 자동으로 넣는다. `nest-cli.json`에 등록한다.

```json
{
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "plugins": [
      {
        "name": "@nestjs/swagger",
        "options": {
          "introspectComments": true
        }
      }
    ]
  }
}
```

옵션이 필요 없다면 `"plugins": ["@nestjs/swagger"]`처럼 이름만 적어도 된다. 플러그인이 하는 일은 다음과 같다.

- `@ApiHideProperty()`가 없는 모든 DTO 속성에 `@ApiProperty()`를 붙인다.
- `?` 여부로 `required`를 정한다. `name?: string`은 `required: false`가 된다.
- 타입으로 `type`이나 `enum`을 정한다. 배열도 지원한다.
- 초깃값으로 `default`를 정한다.
- `classValidatorShim`이 켜져 있으면 `@Max(10)` 같은 `class-validator` 데코레이터를 스키마 규칙(`maximum: 10`)으로 옮긴다.
- 모든 엔드포인트에 반환 타입 기반의 응답 데코레이터를 추가한다.
- `introspectComments`가 켜져 있으면 주석으로 설명과 예시를 만든다.

| 옵션 | 기본값 | 의미 |
|---|---|---|
| `dtoFileNameSuffix` | `['.dto.ts', '.entity.ts']` | 이 접미사를 가진 파일만 DTO로 분석 |
| `controllerFileNameSuffix` | `['.controller.ts']` | 이 접미사를 가진 파일만 컨트롤러로 분석 |
| `classValidatorShim` | `true` | `class-validator` 데코레이터를 스키마에 반영 |
| `introspectComments` | `false` | 주석으로 `description`, `example` 생성 |
| `dtoKeyOfComment` | `'description'` | DTO 속성 주석을 넣을 `ApiProperty` 키 |

플러그인은 **파일 이름 접미사로 대상을 고른다**. `create-order.ts`처럼 접미사가 다른 파일의 클래스는 분석되지 않아 스키마가 비어 나온다. 또 플러그인은 Nest CLI의 빌드 과정(`nest build`, `nest start`)에 끼어드는 TypeScript 트랜스포머(transformer)이므로, `tsc`나 `ts-node`로 직접 실행하면 적용되지 않는다. 옵션을 바꾼 뒤에는 `dist` 폴더를 지우고 다시 빌드한다.

`introspectComments`를 켜면 다음처럼 주석만으로 설명과 예시가 들어간다.

```ts
export class CreateOrderDto {
  /**
   * 주문할 상품 ID
   * @example 42
   */
  @IsInt()
  productId: number;

  @IsInt()
  @Min(1)
  quantity: number = 1;

  @IsOptional()
  @IsString({ each: true })
  tags?: string[];
}
```

플러그인을 쓰더라도 명시한 `@ApiProperty()`의 값이 우선하므로, 자동으로 추론할 수 없는 정보(예: `enumName`, 형식이 정해진 문자열의 `format`)만 직접 적으면 된다.

## 매핑 타입

생성용 DTO에서 수정용 DTO를 만들 때 쓰는 매핑 타입(mapped types)은 `@nestjs/mapped-types`에도 있지만, Swagger 문서를 쓴다면 **`@nestjs/swagger`에서 가져와야 한다**. `@nestjs/mapped-types`의 함수는 검증·변환 메타데이터만 복사하고 Swagger 메타데이터는 복사하지 않아, 수정용 DTO의 스키마가 비어 나온다.

```ts
import { OmitType, PartialType, PickType, IntersectionType } from '@nestjs/swagger';

export class UpdateOrderDto extends PartialType(CreateOrderDto) {}
export class OrderSummaryDto extends PickType(OrderDto, ['id', 'status'] as const) {}
export class CreateOrderBodyDto extends OmitType(CreateOrderDto, ['status'] as const) {}
export class OrderWithUserDto extends IntersectionType(OrderDto, UserDto) {}
```

| 함수 | 결과 |
|---|---|
| `PartialType(A)` | A의 모든 속성을 선택 속성으로 |
| `PickType(A, keys)` | 지정한 속성만 |
| `OmitType(A, keys)` | 지정한 속성을 제외 |
| `IntersectionType(A, B)` | A와 B의 속성을 합침 |

매핑 타입은 서로 조합할 수 있다. `PartialType(OmitType(CreateOrderDto, ['status'] as const))`처럼 쓰면 `status`를 뺀 나머지를 모두 선택 속성으로 만든다.

## JSON으로 내보내 클라이언트 코드 생성하기

문서를 파일로 남겨 두면 프런트엔드나 다른 서비스가 타입과 API 클라이언트를 생성할 수 있다. 서버를 띄운 뒤 `/docs-json`을 받아도 되지만, 빌드 단계에서 만들려면 앱을 초기화해 문서를 쓰고 바로 종료하는 스크립트를 둔다.

```ts
import { writeFileSync } from 'fs';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';

async function generate() {
  const app = await NestFactory.create(AppModule, { logger: false });
  const document = SwaggerModule.createDocument(app, buildSwaggerConfig(), {
    operationIdFactory: (controllerKey, methodKey) => methodKey,
  });
  writeFileSync('openapi.json', JSON.stringify(document, null, 2));
  await app.close();
}
generate();
```

`operationId`의 기본값은 `컨트롤러클래스이름_메서드이름`(예: `OrdersController_create`)이다. 코드 생성기는 이 값을 함수 이름으로 쓰므로, 위처럼 `operationIdFactory`로 메서드 이름만 쓰게 하면 생성된 코드가 읽기 쉬워진다. 다만 여러 컨트롤러에 같은 이름의 메서드(`findAll` 등)가 있으면 `operationId`가 겹치므로, OpenAPI 명세가 요구하는 유일성을 지키려면 중복이 없는지 확인해야 한다.

```bash
npx openapi-typescript openapi.json -o src/api/schema.ts
```

```bash
npx @openapitools/openapi-generator-cli generate -i openapi.json -g typescript-axios -o src/api
```

| 도구 | 생성물 | 특징 |
|---|---|---|
| `openapi-typescript` | 타입 정의만 | 런타임 코드가 없어 가볍다. `fetch` 래퍼는 직접 고른다. |
| `openapi-generator` | 타입 + API 클라이언트 | 여러 언어와 HTTP 라이브러리를 지원한다. Java 런타임이 필요하다. |

`openapi.json`을 저장소에 커밋해 두면 API 변경이 코드 리뷰에서 diff로 드러나고, CI에서 다시 생성한 결과와 비교해 문서를 갱신하지 않은 변경을 잡아낼 수 있다.

## 정리

- `DocumentBuilder`로 제목·버전·보안 스키마를 정하고, `SwaggerModule.createDocument()`로 문서를 만들어 `setup()`으로 노출한다. `setup('docs', ...)`이면 `/docs-json`, `/docs-yaml`도 함께 열린다.
- `@ApiTags()`, `@ApiResponse()`, `@ApiBearerAuth()`, `@ApiProperty()`로 탐색만으로 알 수 없는 정보를 보완한다. `@ApiBearerAuth()`는 `addBearerAuth()`와 짝을 이룬다.
- CLI 플러그인을 `nest-cli.json`에 등록하면 DTO 속성의 타입, 필수 여부, 기본값, 검증 규칙이 자동으로 들어간다. 파일 접미사 규칙과 Nest CLI 빌드에서만 동작한다는 점을 기억한다.
- `PartialType` 등 매핑 타입은 `@nestjs/swagger`에서 가져와야 스키마가 유지된다.
- 문서를 JSON으로 내보내 클라이언트 코드를 생성하고, `operationIdFactory`로 함수 이름을 다듬는다.
