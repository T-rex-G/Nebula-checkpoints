package com.example;

import java.net.URLEncoder;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import org.jsoup.Jsoup;
import org.jsoup.safety.Safelist;

@RestController
public class SearchController {
    private final JdbcTemplate jdbc;

    public SearchController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping("/posts")
    public Object posts(@RequestParam String title) {
        String clean = Jsoup.clean(title, Safelist.basic());
        return jdbc.queryForList("SELECT * FROM posts WHERE title = '" + clean + "'"); // expect: SEC-001
    }
}
