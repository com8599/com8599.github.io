---
layout: post
title: 채팅 데이터를 MongoDB에 두는 기준
date: 2022-12-21
tags: [nestjs]
description: 접근 패턴으로 저장소를 나누는 폴리글랏 퍼시스턴스와, 그 대가로 생기는 일관성 문제.
---

데이터가 쓰이는 방식에 따라 여러 저장 기술을 골라 함께 쓰는 것을 **폴리글랏 퍼시스턴스**(Polyglot Persistence)라고 한다. 하나의 애플리케이션 안에서도 데이터 성격에 따라 저장소를 나눌 수 있다. 기준은 기술 선호가 아니라 데이터의 접근 패턴이다.

## 접근 패턴 비교

| | 회원·매칭·결제 | 채팅·알림 |
|---|---|---|
| 쓰기 | 생성·수정 혼합 | 추가 위주, 수정 드묾 |
| 읽기 | 여러 엔티티 조인 | 한 방의 최근 N개 |
| 관계 | 강함 | 약함(사용자 ID 참조) |
| 트랜잭션 | 필요 | 거의 불필요 |
| 스키마 | 고정 | 메시지 종류별로 다름 |
| 증가량 | 완만 | 빠름 |

관계와 트랜잭션이 중요한 쪽은 RDB, 추가 위주이고 문서 단위로 읽는 쪽은 문서 DB가 맞다.

## 메시지 스키마

```ts
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class Message {
  @Prop({ required: true })
  roomId: string;

  @Prop({ required: true })
  senderId: number;            // MySQL users.id

  @Prop({ required: true, enum: ['text', 'image', 'system'] })
  type: string;

  @Prop({ type: Object })
  payload: Record<string, unknown>;  // 타입별로 다른 구조

  createdAt: Date;
}

export const MessageSchema = SchemaFactory.createForClass(Message);
MessageSchema.index({ roomId: 1, createdAt: -1 });
```

`{ roomId: 1, createdAt: -1 }` 복합 인덱스(compound index) 하나로 "방별 최신순" 조회를 처리한다. `roomId`만 쓰는 조회도 이 인덱스의 접두사(prefix)로 처리되므로 `roomId` 단일 인덱스는 따로 두지 않는다.

## 커서 기반 페이지네이션(cursor-based pagination)

메시지는 계속 추가되므로 `skip`/`offset` 방식은 페이지가 밀리고, `skip`은 건너뛸 문서를 처음부터 훑어야 해서 깊이 갈수록 느려진다.

```ts
findBefore(roomId: string, before?: Date, limit = 30) {
  const filter: FilterQuery<Message> = { roomId };
  if (before) filter.createdAt = { $lt: before };
  return this.messageModel.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
}
```

같은 시각의 메시지가 여럿일 수 있으면 `(createdAt, _id)`를 함께 커서로 쓰고, 인덱스도 `{ roomId: 1, createdAt: -1, _id: -1 }`로 맞춘다.

## NestJS에서 두 저장소 함께 쓰기

Prisma 스키마에는 `datasource` 블록을 하나만 둘 수 있다. 여기서는 MySQL은 Prisma, MongoDB는 `@nestjs/mongoose`로 분리한다.

```ts
@Module({
  imports: [
    PrismaModule,
    MongooseModule.forRoot(process.env.MONGO_URL),
    MongooseModule.forFeature([{ name: Message.name, schema: MessageSchema }]),
  ],
})
export class ChatModule {}
```

## 대가: 일관성과 조립

두 DB 사이에는 조인도, 트랜잭션도 없다.

- **조회 조립**: 메시지 목록의 `senderId`를 모아 MySQL에서 한 번에 조회하고 애플리케이션에서 합친다. N+1을 피하려면 반드시 일괄 조회한다.
- **비정규화(denormalization)**: 보낸 사람 이름처럼 자주 쓰는 값은 메시지에 스냅샷으로 저장한다. 이후 이름이 바뀌어도 과거 메시지는 그대로라는 점을 정책으로 받아들인다.
- **양쪽 쓰기**: 매칭 생성(MySQL)과 채팅방 생성(MongoDB)이 함께 일어나야 한다면 원자성이 없다. 한쪽 실패에 대한 재시도나 아웃박스 패턴(Transactional Outbox Pattern)으로 결과적 일관성(eventual consistency)을 맞춘다. 아웃박스 패턴은 MySQL 트랜잭션 안에서 업무 데이터와 함께 outbox 테이블에 이벤트를 기록하고, 별도 프로세스가 이를 읽어 MongoDB 쪽 작업을 수행하는 방식이다. 같은 이벤트가 두 번 이상 처리될 수 있으므로 MongoDB 쪽 작업은 멱등(idempotent)하게 만든다.

## 알림의 보관 기간

알림은 일정 기간이 지나면 의미가 없다. TTL 인덱스로 자동 삭제한다. 인덱스 필드는 Date 타입이어야 하고, 문서는 그 값에 `expireAfterSeconds`를 더한 시각이 지나면 삭제 대상이 된다.

```ts
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });
```

삭제는 60초마다 도는 백그라운드 작업이 처리하므로 만료 직후 바로 지워진다는 보장은 없다.

저장소를 나누면 운영 대상이 늘어난다. 접근 패턴이 명확히 다르고, 그 차이가 성능이나 개발 비용에서 드러날 때 나누는 것이 맞다.
