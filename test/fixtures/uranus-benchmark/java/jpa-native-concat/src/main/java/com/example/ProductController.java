package com.example;

import jakarta.persistence.EntityManager;
import org.springframework.web.bind.annotation.*;

@RestController
public class ProductController {
    private final EntityManager em;

    public ProductController(EntityManager em) {
        this.em = em;
    }

    @GetMapping("/products")
    public List<?> search(@RequestParam("q") String term) {
        return em.createNativeQuery("SELECT * FROM products WHERE name LIKE '%" + term + "%'").getResultList(); // expect: SEC-001
    }
}
