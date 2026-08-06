package com.warroomlive.config;

import com.warroomlive.signaling.RoomManager;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.binder.MeterBinder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Registers room-state gauges without coupling {@link RoomManager} to Micrometer —
 * the domain object just exposes counts, metrics stay an infrastructure concern.
 */
@Configuration
public class MetricsConfig {

    @Bean
    MeterBinder roomMetrics(RoomManager rooms) {
        return registry -> {
            Gauge.builder("warroomlive.rooms.active", rooms::roomCount)
                    .description("Rooms with at least one connected peer")
                    .register(registry);
            Gauge.builder("warroomlive.rooms.members", rooms::memberCount)
                    .description("Connected peers across all rooms")
                    .register(registry);
        };
    }
}
