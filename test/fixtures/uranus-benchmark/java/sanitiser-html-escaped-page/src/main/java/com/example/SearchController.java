package com.example;

import java.net.URLEncoder;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import org.apache.commons.text.StringEscapeUtils;

@RestController
public class SearchController {
    private final JdbcTemplate jdbc;

    public SearchController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping("/hello")
    public String hello(@RequestParam String name) {
        return "<h1>Hello " + StringEscapeUtils.escapeHtml4(name) + "</h1>";
    }
}
