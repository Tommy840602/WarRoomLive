package com.warroomlive.config;

import com.warroomlive.signaling.Backplane;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.binder.MeterBinder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Registers room-state gauges without coupling the signaling domain to Micrometer —
 * the domain objects just expose counts, metrics stay an infrastructure concern.
 * Counts come from the backplane, so on a Redis deployment every node reports the
 * cluster-wide view (connection counts remain per-node in SignalingHandler).
 */
@Configuration
public class MetricsConfig {

    @Bean
    MeterBinder roomMetrics(Backplane backplane) {
        return registry -> {
            Gauge.builder("warroomlive.rooms.active", backplane::roomCount)
                    .description("Rooms with at least one connected peer (cluster-wide)")
                    .register(registry);
            Gauge.builder("warroomlive.rooms.members", backplane::memberCount)
                    .description("Connected peers across all rooms (cluster-wide)")
                    .register(registry);
        };
    }
}
