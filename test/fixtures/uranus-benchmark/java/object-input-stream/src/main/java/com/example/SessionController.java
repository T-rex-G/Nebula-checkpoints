package com.example;

import java.io.ByteArrayInputStream;
import java.io.ObjectInputStream;
import java.util.Base64;
import org.springframework.web.bind.annotation.*;

@RestController
public class SessionController {
    @PostMapping("/session/restore")
    public Object restore(@RequestBody String token) throws Exception {
        try (ObjectInputStream in = new ObjectInputStream(new ByteArrayInputStream(Base64.getDecoder().decode(token)))) { // expect: SEC-024
            return in.readObject();
        }
    }
}
