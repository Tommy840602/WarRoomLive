package com.warroomlive.events;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Ships outbox rows to the broker: polls unpublished rows in id order (batches
 * claimed with {@code FOR UPDATE SKIP LOCKED}, so replicas cooperate), sends each
 * envelope synchronously, and marks it published in the same transaction.
 *
 * <p>Delivery is at-least-once: a crash between send and commit re-sends the row
 * on the next tick — consumers must dedupe on {@code eventId}. A broker outage
 * simply leaves rows unpublished; the next successful tick catches up in order.
 */
@Component
@Profile("kafka")
public class OutboxPublisher {

    private static final Logger log = LoggerFactory.getLogger(OutboxPublisher.class);
    private static final int BATCH_SIZE = 100;
    private static final long SEND_TIMEOUT_SECONDS = 10;

    private final OutboxJpaRepository outbox;
    private final KafkaTemplate<String, String> kafka;
    private final ObjectMapper mapper;
    private final MeterRegistry metrics;
    private final String topic;

    public OutboxPublisher(
            OutboxJpaRepository outbox,
            KafkaTemplate<String, String> kafka,
            ObjectMapper mapper,
            MeterRegistry metrics,
            @Value("${warroomlive.events.topic:warroom.events}") String topic) {
        this.outbox = outbox;
        this.kafka = kafka;
        this.mapper = mapper;
        this.metrics = metrics;
        this.topic = topic;
    }

    @Scheduled(fixedDelayString = "${warroomlive.events.poll-interval-ms:1000}")
    @Transactional
    public void publishPending() {
        List<OutboxEventEntity> batch = outbox.lockNextUnpublished(BATCH_SIZE);
        for (OutboxEventEntity event : batch) {
            try {
                kafka.send(topic, event.aggregateId(), envelope(event))
                        .get(SEND_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception e) {
                // Stop the batch: this and later rows stay unpublished and retry in
                // order on the next tick. Rows already marked in this transaction
                // were sent — at-least-once, never at-most-once.
                log.warn("Outbox publish halted at event {} ({}): {}",
                        event.eventId(), event.eventType(), e.getMessage());
                break;
            }
            event.markPublished();
            metrics.counter("warroomlive.events.published", "type", event.eventType()).increment();
        }
    }

    /** Stable wire envelope; payload rides embedded, consumers dedupe on eventId. */
    private String envelope(OutboxEventEntity event) throws Exception {
        ObjectNode root = mapper.createObjectNode();
        root.put("eventId", event.eventId().toString());
        root.put("eventType", event.eventType());
        root.put("aggregateType", event.aggregateType());
        root.put("aggregateId", event.aggregateId());
        root.put("schemaVersion", event.schemaVersion());
        root.put("occurredAt", event.occurredAt().toString());
        root.set("payload", mapper.readTree(event.payload()));
        return mapper.writeValueAsString(root);
    }
}
