package com.warroomlive.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.server.resource.web.DefaultBearerTokenResolver;
import org.springframework.security.web.SecurityFilterChain;

/**
 * Two mutually exclusive security modes, selected by the {@code oidc} profile:
 *
 * <ul>
 *   <li><b>Default</b> — permit-all. Local development needs no identity provider,
 *       matching the zero-dependency default of chat storage and collab persistence.
 *   <li><b>{@code oidc}</b> — the server is an OAuth2 resource server: every request
 *       except health and the auth-config bootstrap needs a valid JWT from the
 *       configured issuer. WebSocket handshakes cannot carry an Authorization header
 *       from the browser, so the bearer token is also accepted as an
 *       {@code access_token} query parameter (RFC 6750 §2.3).
 * </ul>
 *
 * <p>Authorization decisions stay server-side; the frontend only adapts its UI.
 */
@Configuration
public class SecurityConfig {

    @Bean
    @Profile("!oidc")
    SecurityFilterChain permitAllChain(HttpSecurity http) throws Exception {
        http.csrf(csrf -> csrf.disable())
                .authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
        return http.build();
    }

    @Bean
    @Profile("oidc")
    SecurityFilterChain jwtChain(HttpSecurity http, JwtDecoder jwtDecoder) throws Exception {
        DefaultBearerTokenResolver resolver = new DefaultBearerTokenResolver();
        resolver.setAllowUriQueryParameter(true);
        http.csrf(csrf -> csrf.disable())
                .authorizeHttpRequests(auth -> auth
                        // /actuator is not proxied by nginx, so it stays reachable only
                        // from inside the compose network (Prometheus scraper).
                        // The LiveKit webhook authenticates itself (body-hash JWT
                        // signed with the API secret, verified in its controller).
                        .requestMatchers("/api/health", "/api/auth/config", "/api/livekit/webhook", "/actuator/**").permitAll()
                        .anyRequest().authenticated())
                .oauth2ResourceServer(rs -> rs
                        .bearerTokenResolver(resolver)
                        .jwt(jwt -> jwt.decoder(jwtDecoder)));
        return http.build();
    }

    /**
     * Validates signatures against the provider's JWKS (fetched over the internal
     * network) while requiring the public issuer string browsers see — the two differ
     * behind the single-origin proxy, which is why plain {@code issuer-uri}
     * autoconfiguration is not used.
     */
    @Bean
    @Profile("oidc")
    JwtDecoder jwtDecoder(
            @Value("${warroomlive.auth.jwk-set-uri}") String jwkSetUri,
            @Value("${warroomlive.auth.issuer}") String issuer) {
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withJwkSetUri(jwkSetUri).build();
        decoder.setJwtValidator(JwtValidators.createDefaultWithIssuer(issuer));
        return decoder;
    }
}
