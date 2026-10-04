package com.example;

import org.springframework.web.bind.annotation.*;
import org.springframework.jdbc.core.JdbcTemplate;

@RestController
@RequestMapping("/api")
public class NoteController {
    private final JdbcTemplate jdbc;

    public NoteController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @PostMapping("/notes")
    public void create(@RequestBody Note note) { // expect: ACC-001 to-confirm
        jdbc.update("INSERT INTO notes (title) VALUES (?)", note.getTitle());
    }

}
