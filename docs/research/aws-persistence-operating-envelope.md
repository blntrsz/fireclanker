# AWS persistence operating envelope for Fireclanker

_Research date: 2026-07-13. All factual claims below are grounded in first-party AWS documentation. “Inference” sections apply those facts to Fireclanker; they are decision support, not a resolution of the architecture ticket._

## Question

Which AWS persistence primitives and limits are relevant to durable Job state, appendable Execution Transcripts, concurrent watching, terminal Outcomes, cancellation signals, indexing, and retention expiry, and what trade-offs do DynamoDB, S3, and their combinations impose?

The immediate consumer is the decision **Choose the Job persistence and transcript streaming architecture**: how Fireclanker should persist Job metadata, Job Status transitions, Execution Transcript events, cancellation, Outcomes, and retention expiry so detached CLI clients can reliably inspect or watch a Job.

## Executive findings

1. **DynamoDB fits operational Job records and ordered event envelopes.** A successful write is durably persisted; base-table and local-secondary-index reads can be strongly consistent; conditional writes and transactions can protect Job Status transitions and coordinate a Job update with a separate terminal Execution Transcript event. Items are capped at 400 KB, a Query page is capped at 1 MB before filtering, and a physical partition is designed for at most 1,000 write units and 3,000 read units per second. ([read consistency](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html), [constraints](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html), [Query](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.KeyConditionExpressions.html), [partition-key design](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html))
2. **DynamoDB Streams is a notification/change-capture layer, not the durable Execution Transcript or a client watch API.** It retains records for 24 hours, preserves modification order per item, and supports up to two simultaneous consumers per shard; Lambda consumption is at least once even though a record appears once in the stream. A detached watcher must be able to resume from durable table data after reconnecting rather than depend on a stream cursor. ([change data capture comparison](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/streamsmain.html), [Streams/Lambda best practices](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.Lambda.BestPracticesWithDynamoDB.html))
3. **General-purpose S3 fits immutable transcript segments and oversized payloads, but not mutable Job control state or low-latency secondary indexing.** S3 provides strong read-after-write consistency for PUT, DELETE, GET/HEAD metadata, and LIST, and a single-key update is atomic. It provides no atomic update across keys and no built-in concurrent-writer lock. Listing is by key prefix, up to 1,000 objects per response. ([S3 consistency model](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html), [ListObjectsV2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html))
4. **S3 append is real but narrowly scoped.** Appending to an existing object is supported only for objects in S3 Express One Zone in directory buckets located in Availability Zones. Each append supplies an offset equal to the current object size, can add at most 5 GB, creates a part, and an object can have at most 10,000 parts; `CopyObject` resets the part count. Directory buckets do not support S3 Event Notifications, Versioning, Replication, Object Lock, object tags, or Lifecycle transitions, and their listings are not lexicographically ordered. ([append documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/directory-buckets-objects-append.html), [directory-bucket differences](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-differences.html))
5. **Neither DynamoDB TTL nor S3 Lifecycle gives exact deletion time.** DynamoDB normally removes expired items within a few days, while still returning and charging for them until deletion. S3 queues eligible objects for asynchronous removal and can lag the calculated expiration date; age-based actions round to the next midnight UTC. Fireclanker therefore needs an application-level expiry rule if a Job must become inaccessible at a precise instant, with TTL/Lifecycle used for eventual physical reclamation. ([DynamoDB TTL](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html), [expired DynamoDB items](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ttl-expired-items.html), [S3 expiration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-expire-general-considerations.html), [S3 Lifecycle calculation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intro-lifecycle-rules.html))
6. **The two decision-worthy MVP shapes are:** (A) DynamoDB for Job records and all bounded Execution Transcript events, with S3 only for event payloads that exceed a chosen threshold; or (B) DynamoDB for Job control/index records plus immutable, ordered S3 transcript segments. S3-only control state and a single appendable S3 Express object both add material coordination, indexing, recovery, or resilience constraints. This is an inference from the service facts, not the architecture decision.

## Required Fireclanker capabilities mapped to AWS primitives

| Fireclanker need | DynamoDB primitive | General-purpose S3 primitive | Important gap |
|---|---|---|---|
| Durable Job metadata and Job Status | Item keyed by Job ID; conditional `UpdateItem`; optional transaction | Object overwrite with `If-Match` or immutable versioned objects | S3 has no multi-key transaction or application lock; DynamoDB is bounded to 400 KB per item |
| Appendable Execution Transcript | One immutable event per item, using Job ID as partition key and an ordered sort key | One immutable object per event/segment; lexicographically ordered key names in a general-purpose bucket | Both require Fireclanker to define the canonical event ID/order and idempotency rule |
| Concurrent watching | Query durable events after a cursor; optionally wake a shared fan-out process from DynamoDB Streams | Poll LIST/GET after a cursor; optionally wake a shared fan-out process from S3 Event Notifications | Neither service directly provides CLI-facing watch transport; notifications are hints, not the replay source |
| Cancellation signal | Conditional update on the Job record; worker can strongly read it or consume a change hint | Presence/overwrite of a cancellation object | S3 cannot atomically validate cancellation against Job Status; neither service interrupts compute by itself |
| Terminal Outcome | Store bounded Response/Change Set inline, or a pointer; transactionally coordinate succeeded Job Status and a separate terminal event | Immutable Outcome object, optionally referenced by DynamoDB | Cross-service atomicity does not exist; failures need reconciliation if Outcome bytes and Job state use different services |
| Index/list Jobs | Table key design and GSIs | Key-prefix listing; delayed Inventory or Metadata tables for analytics | GSIs are eventually consistent; S3 analytics indexes are not a low-latency operational index |
| Retention expiry | Per-item TTL | Lifecycle expiration by prefix/tag/age | Both reclaim asynchronously; a whole Job spans many records/objects |
| Recovery | PITR (1–35 days) and on-demand backup | Versioning, Object Lock, replication, lifecycle, depending on bucket type | S3 Express directory buckets omit several of these protections |

## DynamoDB operating envelope

### Durability, availability, and consistency

DynamoDB automatically replicates table data across three Availability Zones in a Region and carries a 99.99% availability SLA for the standard single-Region service. ([DynamoDB resilience](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/disaster-recovery-resiliency.html)) A successful write that returns HTTP 200 has been durably persisted. DynamoDB provides read-committed isolation; base tables and local secondary indexes support both eventual and strong reads, while global secondary indexes (GSIs) and streams support only eventual reads. ([read consistency](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html))

**Inference for Fireclanker.** A direct, strongly consistent read of the Job item is suitable for an authoritative inspect operation and for a worker checking a cancellation signal. A GSI-backed Job listing can temporarily show an older Job Status, so the API should treat the base Job record—not an index row—as authoritative when correctness matters.

### Item, transaction, and throughput limits

- An item, including attribute names and values, can be at most 400 KB. ([DynamoDB constraints](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html))
- `TransactWriteItems` atomically applies up to 100 actions totaling at most 4 MB. Actions may span tables in one account and Region, but two actions cannot target the same item. An idempotency token is supported. ([TransactWriteItems API](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html))
- Each physical partition is designed for at most 3,000 read units and 1,000 write units per second. A read unit covers one strongly consistent 4 KB read per second or two eventually consistent reads; a write unit covers one 1 KB write per second. Larger items consume proportionally more units. ([partition-key design](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html))
- The initial adjustable table-level quota is 40,000 read units and 40,000 write units per second for both on-demand and provisioned tables. ([DynamoDB quotas](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html))
- A local secondary index imposes a 10 GB limit on the complete item collection for one partition-key value; a table without local secondary indexes does not have that item-collection limit. Each table has default quotas of 20 GSIs and 5 local secondary indexes. ([secondary-index guidance](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-indexes-general.html), [local secondary indexes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/LSI.html))

Without a local secondary index, DynamoDB can split one item collection across as many physical partitions as storage and throughput require. With a local secondary index it cannot split the item collection, which is the reason for the 10 GB cap. ([partitions and data distribution](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.Partitions.html), [DynamoDB constraints](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html))

**Inference for Fireclanker.** An Execution Transcript event must be split or externalized before it approaches 400 KB; raw command output can exceed this even when the logical event envelope is small. Keeping every event for a Job under one partition key gives efficient ordered replay. It initially concentrates traffic, however, and a steadily increasing sort key may remain hot because splitting would send all new writes to the newest range. Avoiding a local secondary index lets DynamoDB split a large/hot item collection and removes the 10 GB per-Job ceiling, but Fireclanker should still measure hot-Job behavior rather than assume unlimited per-Job write rate. ([AWS split-for-heat analysis](https://aws.amazon.com/blogs/database/part-2-scaling-dynamodb-how-partitions-hot-keys-and-split-for-heat-impact-performance/))

### Ordering, idempotency, and concurrency

DynamoDB stores items sharing a partition-key value in sort-key order. Query results are ordered numerically for numeric sort keys or by UTF-8 bytes for other sort-key types; a Query page is limited to 1 MB before any filter or projection is applied. The partition key must be supplied as an equality condition, and an optional sort-key condition can use comparisons, `BETWEEN`, or `begins_with`. ([Query key conditions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.KeyConditionExpressions.html))

Individual CRUD operations are atomic. `UpdateItem` acts on the latest item version; conditional writes implement optimistic conflict detection, and transactions coordinate multiple items. ([concurrent-update guidance](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/BestPractices_ImplementingVersionControl.html)) `PutItem`, `UpdateItem`, and `DeleteItem` accept condition expressions; for example, `attribute_not_exists` prevents replacing an existing primary key. ([condition expressions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.ConditionExpressions.html)) Atomic counters exist, but increments are not idempotent: retrying can overcount. ([items and atomic counters](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/WorkingWithItems.html))

**Inference for Fireclanker.** DynamoDB provides ordered storage, not an automatic Job-wide sequence allocator. Fireclanker must choose one of these policies:

- a single logical transcript writer assigns monotonically increasing sequence numbers;
- writers create collision-resistant ordered IDs and accept that the ID defines total order rather than strict causal order; or
- writers coordinate sequence allocation, accepting contention and retry complexity.

Each event should have an idempotency identity and be inserted conditionally. An unconditional atomic counter alone is unsafe as the canonical sequence when a timed-out request might be retried. If completing a successful Job must atomically update the Job Status, store a bounded Outcome or its pointer, and insert a terminal Execution Transcript event, those can be separate items in one `TransactWriteItems` request, within the 100-action/4-MB limit. A transaction cannot perform two actions on the same Job item, so all Job-item mutations in that completion need one update expression.

### Indexing

A DynamoDB Query requires the partition-key value. Access patterns that do not know the table partition key need a secondary index or a Scan. GSIs may use different keys from the base table and have no 10 GB item-collection limit, but they update asynchronously, only support eventual reads, consume storage/write capacity, and can throttle base-table writes when a provisioned GSI lacks capacity. A low-cardinality GSI partition key such as a single popular status can create a hot partition. ([GSI behavior](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html), [GSI throttling](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/gsi-throttling.html))

**Inference for Fireclanker.** The MVP must enumerate Job-list access patterns before choosing keys: for example, all Jobs by submitter and creation time, active Jobs, Jobs for a Focus Repository, or Jobs by Job Status. Index records should project only what list responses require. A GSI status partition should normally be bucketed or otherwise distributed if `queued`/`running` can be high-volume. Repository Catalog data and Focus Repository identifiers can be attributes and index keys, but the persistence choice does not decide Repository Catalog semantics.

### Watching and change capture

DynamoDB Streams retains change records for 24 hours. For each modified item, stream records appear in the same order as the actual item modifications; the service stream has no duplicate records and supports up to two simultaneous consumers per shard. Streams is a pull model over `GetRecords`. ([change data capture comparison](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/streamsmain.html)) A shard iterator expires after 15 minutes, and stream data older than 24 hours is trimmed. ([GetShardIterator](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_streams_GetShardIterator.html)) `GetRecords` returns at most 1 MB or 1,000 records. ([GetRecords](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_streams_GetRecords.html)) Lambda polls a DynamoDB stream four times per second, and more than two Lambda subscriptions can cause read throttling. ([Streams and Lambda](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.Lambda.html)) A Lambda stream consumer is at-least-once and can process a record more than once. ([Streams/Lambda best practices](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.Lambda.BestPracticesWithDynamoDB.html))

**Inference for Fireclanker.** One stream consumer should wake or feed a Fireclanker-owned fan-out layer; one Streams consumer per CLI watcher is not viable. The durable watch contract should be cursor-based: query Execution Transcript events after the last acknowledged event, then wait for a hint or poll, and query again. This tolerates duplicated, lost, delayed, or expired notification delivery because the durable table, not the stream, is the source of replay.

Polling DynamoDB directly is a valid MVP mechanism: each watcher repeatedly queries the Job partition after its cursor. It is simpler than a push fan-out layer but multiplies read requests with watcher count and poll frequency. Strongly consistent base-table queries can close read-after-write gaps at twice the eventually consistent read-unit rate. ([DynamoDB pricing dimensions](https://aws.amazon.com/dynamodb/pricing/))

### Cancellation and Job Status transitions

Conditional writes can require the current stored attributes to match an expected value before updating an item; if the condition is false, the write fails. ([condition expressions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.OperatorsAndFunctions.html))

**Inference for Fireclanker.** A durable cancellation request can be an attribute such as `cancellationRequestedAt` on the authoritative Job item rather than a new Job Status, preserving the defined Job Status vocabulary (`queued`, `running`, `succeeded`, `failed`, `cancelled`). A conditional update can accept cancellation only while the Job Status is `queued` or `running`; the worker then cooperatively transitions it to `cancelled`. The architecture decision still must specify race semantics between cancellation and successful completion. A stream notification can reduce response latency, but the worker should be able to discover the signal from a strongly consistent read after a missed notification.

### Retention and recovery

DynamoDB TTL uses one numeric Unix-epoch-seconds attribute per item. Expired items are normally deleted within a few days without consuming source-table write throughput, but they remain readable, writable, chargeable for storage/reads, and present in indexes until background deletion. Query and Scan filters can hide them. ([DynamoDB TTL](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html), [expired items](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ttl-expired-items.html)) TTL deletions appear as service deletions in the local Region's stream. Replicated TTL deletions in global tables consume replicated write units and are not identifiable as TTL deletes in other Regions. ([TTL and Streams](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/time-to-live-ttl-streams.html))

PITR is optional and provides recovery points at per-second granularity for a configurable 1–35 day window, restoring into a new table; the latest restorable point is normally about five minutes behind. ([backup and restore](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Backup-and-Restore.html), [PITR behavior](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/PointInTimeRecovery_Howitworks.html))

**Inference for Fireclanker.** Every Job item, transcript event, auxiliary index record, and S3 pointer item must carry a compatible expiry value, or the Job will be only partially reclaimed. API reads should compare the Job's logical expiry before returning any data. TTL is physical cleanup, not a precise access-control boundary. PITR can recover accidentally deleted data, which means it can also retain recoverable copies beyond the live-data TTL window; the product's retention promise must distinguish live visibility, physical deletion, and backup recoverability.

### Cost shape

DynamoDB charges for table reads, writes, storage, and enabled optional features. On-demand writes are metered in 1 KB increments, reads in 4 KB increments, strong reads use twice the request units of eventual reads, and transactional operations use twice the units of standard operations. GSIs add storage and write/read usage. ([DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/)) DynamoDB Standard-IA reduces storage price but raises read/write price relative to Standard and is intended for storage-dominant, infrequently accessed tables; it has the same performance, durability, and availability. ([table classes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/WorkingWithTables.tableclasses.html))

**Inference for Fireclanker.** Small transcript events are request-heavy because each is rounded to at least 1 KB and every projected GSI can amplify writes. Large retained Execution Transcripts are storage-heavy. A single table cannot assign Standard to active records and Standard-IA only to old records, so tiering within DynamoDB requires separate tables or archival elsewhere.

## S3 operating envelope

### General-purpose bucket consistency and concurrency

S3 gives strong read-after-write consistency for object PUT and DELETE operations in every Region, including overwrite, and strong consistency for object metadata and LIST. A successful PUT is immediately visible to subsequent GET and LIST requests. Updates to one key are atomic: readers see either the old or new object, not partial data. S3 does not provide a concurrent-writer lock, and it cannot make one key's update conditional on another key's update. ([S3 consistency model](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html))

Conditional writes support `If-None-Match: *` to create only when a key is absent and `If-Match: <ETag>` to replace only the expected version; failed preconditions return an error and concurrent conflicts can require retry. ([S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html), [PutObject API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html))

S3 currently supports objects up to 48.8 TiB, composed of at most 10,000 multipart parts of 5 MiB–5 GiB; a single `PutObject` upload is limited to 5 GB. ([multipart limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html), [uploading objects](https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html))

**Inference for Fireclanker.** Immutable keys such as `jobs/<job-id>/transcript/<ordered-event-id>.json` are safer than repeatedly overwriting one transcript object. A conditional create makes event publication idempotent if the event ID is stable. General-purpose-bucket LIST is strongly consistent and lexicographically ordered, so fixed-width numeric sequences or correctly sortable IDs can support replay. S3 still does not allocate those IDs or atomically update the Job Status at another key.

### Append support: only S3 Express One Zone directory buckets

S3 can append bytes to an existing object only when that object is in the S3 Express One Zone storage class in a directory bucket located in an Availability Zone. The request is `PutObject` with `x-amz-write-offset-bytes` equal to the current object size; a wrong offset returns `InvalidWriteOffset`. There is no minimum append size, the maximum per request is 5 GB, and every successful append adds one object part. The object may have at most 10,000 total parts, including multipart-upload parts; exceeding that returns `TooManyParts`, and copying the object resets the count. Every append is billed as a PUT request. ([append documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/directory-buckets-objects-append.html), [PutObject errors](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html))

Directory buckets use Zonal endpoints and temporary session credentials for object operations. `ListObjectsV2` does not return lexicographical order. Directory buckets do not support S3 Event Notifications, Versioning, Replication, Object Lock, object tags, or Lifecycle transition actions; append is also unavailable for directory buckets in Local Zones. ([directory-bucket differences](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-differences.html)) Lifecycle expiration is supported for directory buckets, despite Lifecycle transitions being unsupported. ([directory-bucket Lifecycle example](https://docs.aws.amazon.com/AmazonS3/latest/userguide/directory-bucket-create-lc.html))

S3 Express One Zone stores redundant copies on multiple devices within one Availability Zone, not across Availability Zones, and is designed for 99.95% availability within that Zone. ([S3 Express One Zone](https://docs.aws.amazon.com/AmazonS3/latest/userguide/directory-bucket-high-performance.html))

**Inference for Fireclanker.** Two appenders that observe the same current length will race; after one succeeds, the other's offset is stale and it must re-read and retry. Thus the offset check prevents silent overlap but does not supply multi-writer sequencing. At one append per Execution Transcript event, 10,000 events exhaust the part count; batching extends that horizon but increases watch latency and makes crash recovery responsible for buffered bytes. Copying to reset parts rewrites the coordination problem and creates an operational rollover step.

The combination of single-AZ placement, no event notifications, no replication/versioning, unordered LIST, and a 10,000-append lifecycle makes one S3 Express appendable object a specialized optimization rather than a neutral default for Fireclanker's durable Execution Transcript.

### Immutable segments, listing, and indexing

`ListObjectsV2` returns at most 1,000 objects per request. A general-purpose bucket returns keys lexicographically and accepts a prefix; a directory bucket does not guarantee lexicographic order. ([ListObjectsV2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html)) Prefixes are leading substrings of object keys, not true directories. ([organizing with prefixes](https://docs.aws.amazon.com/us_en/AmazonS3/latest/userguide/using-prefixes.html)) S3 has no ordinary object API for querying arbitrary metadata as an operational index. User-defined object metadata is limited to 2 KB and can be changed only by copying the object; each object has at most 10 tags. ([object metadata](https://docs.aws.amazon.com/en_en/AmazonS3/latest/userguide/UsingMetadata.html), [S3 quotas](https://docs.aws.amazon.com/general/latest/gr/s3.html))

S3 Inventory produces daily or weekly CSV/ORC/Parquet listings and can take up to 48 hours to deliver the first report. ([S3 Inventory](https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-inventory.html)) S3 Metadata supports read-only queryable tables only for general-purpose buckets: journal changes are near real time, while live-inventory changes are typically reflected within one hour after a backfill that takes at least 15 minutes and can take hours. ([S3 Metadata](https://docs.aws.amazon.com/AmazonS3/latest/userguide/metadata-tables-overview.html))

**Inference for Fireclanker.** S3 Inventory and S3 Metadata are useful for audit, analytics, and cleanup verification, not for authoritative low-latency Job lists or Job Status queries. Encoding every query dimension into duplicate marker-object prefixes would denormalize Job state across keys without a multi-key transaction. DynamoDB remains the cleaner operational index even when S3 owns transcript bytes.

### Watching and notifications

General-purpose S3 buckets can emit Event Notifications to SNS, SQS, Lambda, or EventBridge. Delivery is at least once, usually takes seconds but can take a minute or longer, and is not guaranteed in event order; duplicates can occur. A notification `sequencer` orders events only for the same object key, not across different transcript-segment keys. ([S3 Event Notifications](https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventNotifications.html), [event ordering and duplicates](https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-how-to-event-types-and-destinations.html), [event message structure](https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-content-structure.html)) Directory buckets do not support S3 Event Notifications. ([directory-bucket differences](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-differences.html))

**Inference for Fireclanker.** An S3-based watch must use the ordered object key as the replay cursor and treat notifications only as a reason to LIST again. Notifications cannot establish transcript order across segment keys. Direct polling of a known Job prefix works but incurs LIST/GET requests per watcher and has a granularity trade-off: one object per event gives low publish latency and many requests; larger segments reduce request count but require a flush policy and a way to expose only completed immutable segments.

### Retention and recovery

S3 Lifecycle rules can select objects by prefix, tags, size, or combinations and apply expiration or transition actions. Age-based dates are calculated by adding whole days to object creation time and rounding up to the next midnight UTC. Expiration queues the object for asynchronous removal, so physical deletion can lag eligibility; storage billing stops at eligibility for ordinary expiration even if removal is delayed. ([Lifecycle configuration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intro-lifecycle-rules.html), [expiring objects](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-expire-general-considerations.html))

In a versioned general-purpose bucket, expiring the current version normally adds a delete marker; separate rules are needed to permanently delete noncurrent versions and expired delete markers. Each version is a complete object and is billed as such. ([S3 Versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html), [Lifecycle/versioning behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intro-lifecycle-rules.html)) S3 Object Lock can prevent deletion or overwrite for a retention period or legal hold, but it requires Versioning and is therefore unavailable to directory buckets. ([S3 Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html), [directory-bucket differences](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-differences.html))

**Inference for Fireclanker.** Use a Job-specific prefix and a lifecycle rule aligned with the Job's retention class, but do not promise exact physical deletion at an arbitrary timestamp. If different Jobs need arbitrary per-Job expiry dates, the key layout or object tags must make those policies expressible; directory buckets have no object tags. As with DynamoDB, the API should enforce logical expiry immediately and treat Lifecycle as reclamation. Versioning/Object Lock/PITR choices must be reconciled with any promise that an Execution Transcript is irrecoverably deleted after retention.

### Cost shape

S3 charges for stored bytes, request type/count, optional management features, retrieval for some storage classes, and applicable data transfer. LIST is priced like Standard PUT/COPY/POST, DELETE is free, and same-Region transfer between S3 and AWS services is generally not charged. ([S3 pricing](https://aws.amazon.com/s3/pricing/)) Each S3 append is a PUT request. ([append documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/directory-buckets-objects-append.html))

**Inference for Fireclanker.** Immutable small segments trade lower-cost byte storage for PUT/LIST/GET request volume; batching reduces request count at the expense of live-watch latency and more complex crash-safe flushing. Prices are Region- and storage-class-specific, so the architecture ticket should compare representative Job sizes and watcher patterns rather than assume S3 is always cheaper.

## Combination trade-offs

### Candidate A: DynamoDB-first, with S3 overflow payloads

Store the Job record, Job Status, cancellation signal, bounded Outcome or Outcome pointer, and each Execution Transcript event envelope in DynamoDB. Keep ordinary messages/tool metadata inline; place only payloads above a chosen size threshold (for example, large command output or generated artifacts) in immutable general-purpose S3 objects and reference them from the event.

**Advantages (inference):**

- one ordered DynamoDB Query is the canonical replay path;
- a conditional write or transaction can protect Job Status and terminal-event invariants;
- indexing and logical expiry live with the authoritative Job records;
- most watch events need one persistence service, and reconnect does not list S3;
- S3 is used where its large-object capability matters, avoiding the 400 KB ceiling.

**Costs/risks (inference):**

- transcript events pay DynamoDB request/storage costs, and a high-rate Job with an always-increasing sort key can become hot even though DynamoDB may split item collections that have no local secondary index;
- cross-service payload publication is not atomic: write S3 first and DynamoDB second to avoid publishing a live pointer to missing bytes, then reclaim orphan S3 objects after failed DynamoDB writes;
- retention has to cover both the DynamoDB pointer/event and S3 payload;
- the maximum inline-event size and overflow threshold become protocol decisions.

### Candidate B: DynamoDB control plane plus immutable S3 transcript segments

Store the authoritative Job record, Job Status, cancellation signal, Outcome metadata/pointer, and Job indexes in DynamoDB. Store ordered, immutable Execution Transcript segments in a general-purpose S3 bucket. DynamoDB may either hold a small manifest/cursor record or let the Job prefix plus key naming be the S3 manifest.

**Advantages (inference):**

- transcript byte volume uses S3's object scale and lifecycle tooling;
- immutable segments avoid repeated whole-object replacement and avoid the S3 Express append restrictions;
- DynamoDB remains the strongly readable state machine and operational index.

**Costs/risks (inference):**

- watchers need S3 LIST/GET polling or a notification-to-fan-out layer, and notifications cannot order different keys;
- the segment flush size/time policy becomes observable watch latency;
- completion cannot atomically cover DynamoDB Job Status/Outcome and S3's final segment; a protocol must specify publish ordering, “sealed” segments, retry idempotency, and reconciliation;
- per-Job retention must coordinate DynamoDB TTL and S3 Lifecycle;
- one object per event can produce high request counts, while batching introduces buffering failure modes.

### Candidate C: S3-only Job and transcript storage

Represent the Job, Job Status, cancellation, indexes/markers, Outcome, and Execution Transcript as S3 objects.

**Inference:** This is poorly matched to the stated control-plane needs. S3 has strong per-key consistency and conditional replacement, but no cross-key atomicity, no native low-latency secondary index, and no direct watcher stream. Job Status transitions, cancellation-versus-completion races, and duplicate status indexes would require application-level transactions/reconciliation. It is technically possible but removes the main benefit DynamoDB provides.

### Candidate D: one appendable S3 Express transcript object

Keep Job control elsewhere but append every Execution Transcript batch to one directory-bucket object.

**Inference:** This is viable only if the decision explicitly accepts one-AZ storage, offset-based writer coordination, no S3 Event Notifications, no Versioning/Replication/Object Lock, unordered directory-bucket LIST, and rollover before/at 10,000 total parts. It optimizes low-latency in-AZ append/read behavior but makes Fireclanker's durability and watch design depend on a specialized storage class. It should not be treated as generic S3 append support.

## Provisional decision guidance (inference, not the decision)

The AWS operating envelope supports narrowing the HITL decision to **Candidate A** versus **Candidate B**:

- Prefer **Candidate A** when MVP simplicity, low watch latency, straightforward cursor replay, and atomic Job/terminal-event invariants dominate; cap event size and use S3 only for large payloads.
- Prefer **Candidate B** when expected Execution Transcript volume or retention makes DynamoDB byte storage materially unattractive and the product can tolerate/define segment flush latency plus cross-service reconciliation.
- Do not choose **S3-only** unless avoiding DynamoDB is an explicit requirement worth rebuilding indexing and transactional control semantics.
- Do not choose **S3 Express append** merely because the Execution Transcript is conceptually appendable; choose it only after explicitly accepting its directory-bucket and single-AZ constraints.

In either credible shape, the durable watch contract should be **replay after a stable cursor, then wait/poll, then replay again**. DynamoDB Streams or S3 Event Notifications can reduce polling latency, but neither should be the sole record of an Execution Transcript.

## Decisions the architecture ticket still needs to make

1. **Canonical transcript order.** Is there exactly one logical event writer per Job, or must concurrent producers be ordered? Is order strict causal order, producer acceptance order, or merely a stable total order?
2. **Event and volume envelope.** Maximum event size, typical and worst-case Execution Transcript bytes/events per Job, active write rate for one Job, retention period, and expected concurrent watchers.
3. **Watch service level.** Acceptable live latency; whether polling is sufficient for MVP; resume cursor format; behavior when a cursor predates retained data; and whether terminal completion must be delivered in the same ordered stream.
4. **Completion invariant.** For a succeeded Job, must Job Status, Outcome (Response or Change Set), and the terminal Execution Transcript event become visible atomically? For `failed` and `cancelled`, what terminal transcript record is required even though there is no successful Outcome?
5. **Cancellation race.** Which wins when cancellation and completion occur concurrently, when a queued Job can be cancelled without starting, and how quickly a running worker must observe the signal.
6. **Retention semantics.** Exact time data stops being returned; allowed physical-deletion lag; whether backups/versions may remain recoverable; and whether all Jobs share one duration or use per-Job policies.
7. **Job list access patterns.** Required filters and sort orders involving Job Status, submitter, time, Focus Repository, and perhaps Repository Catalog membership; these determine DynamoDB keys/GSIs.
8. **Resilience boundary.** Whether three-AZ single-Region durability is sufficient for MVP, whether cross-Region recovery is in scope, and whether single-AZ S3 Express is categorically excluded for the durable Execution Transcript.
9. **Cross-service publication protocol.** If any transcript/Outcome bytes live in S3, define write order, idempotency keys, orphan cleanup, broken-pointer repair, and how inspect/watch behaves during partial publication.

## Newly surfaced fog

- Whether credentials redaction in the Execution Transcript must be irreversible before the first durable write, and whether later-discovered secrets require rewriting or tombstoning already-persisted transcript material. This affects the attractiveness of immutable events and Object Lock/version retention.
- Whether a Change Set's pull-request references are sufficient as the durable Outcome or whether Fireclanker must preserve patches/diffs independently of the hosting provider. That determines potential Outcome size and S3 use.
- Whether retention is a product/privacy promise or only a cost-control mechanism. The former requires explicit treatment of PITR, Versioning, replication, Object Lock, and delayed deletion; the latter can use simpler logical expiry plus asynchronous reclamation.
- Whether long-running Jobs can exceed 24 hours. If so, the 24-hour DynamoDB Streams window cannot serve reconnect replay even for a single Job, reinforcing the need for durable transcript cursors.
