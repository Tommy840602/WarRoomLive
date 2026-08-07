package com.warroomlive.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Enables the schedule the retention sweep runs on. The other {@code @Scheduled}
 * work in this application belongs to the {@code kafka} and {@code redis}
 * profiles and enables scheduling from there; retention only needs a database,
 * so it gets its own switch rather than inheriting one from an unrelated
 * overlay.
 */
@Configuration
@Profile("postgres")
@EnableScheduling
public class RetentionConfig {
}
