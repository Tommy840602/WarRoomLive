package com.warroomlive.config;

import com.warroomlive.events.OutboxJpaRepository;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.binder.MeterBinder;
import org.apache.kafka.clients.admin.NewTopic;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.kafka.config.TopicBuilder;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Event-backbone wiring for the {@code kafka} profile (requires {@code postgres}
 * — the outbox lives in the database). Declares the events topic and exposes the
 * outbox backlog as a gauge so a stuck publisher is visible in Prometheus.
 */
@Configuration
@Profile("kafka")
@EnableScheduling
public class KafkaConfig {

    @Bean
    NewTopic eventsTopic(@Value("${warroomlive.events.topic:warroom.events}") String topic) {
        return TopicBuilder.name(topic).partitions(3).replicas(1).build();
    }

    @Bean
    MeterBinder outboxMetrics(OutboxJpaRepository outbox) {
        return registry -> Gauge.builder("warroomlive.events.backlog", outbox::countByPublishedAtIsNull)
                .description("Outbox rows not yet published to the broker")
                .register(registry);
    }
}
