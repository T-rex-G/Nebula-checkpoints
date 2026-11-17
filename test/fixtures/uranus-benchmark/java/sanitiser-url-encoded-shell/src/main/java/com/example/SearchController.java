package com.example;

import java.net.URLEncoder;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;

@RestController
public class SearchController {
    private final JdbcTemplate jdbc;

    public SearchController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping("/convert")
    public String convert(@RequestParam String name) throws Exception {
        String file = URLEncoder.encode(name, "UTF-8");
        Runtime.getRuntime().exec("sh -c convert uploads/" + file); // expect: SEC-011
        return "ok";
    }
}
