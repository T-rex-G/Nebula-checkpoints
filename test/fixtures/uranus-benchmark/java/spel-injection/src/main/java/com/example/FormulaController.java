package com.example;

import org.springframework.expression.ExpressionParser;
import org.springframework.expression.spel.standard.SpelExpressionParser;
import org.springframework.web.bind.annotation.*;

@RestController
public class FormulaController {
    private final ExpressionParser parser = new SpelExpressionParser();

    @GetMapping("/formula")
    public Object evaluate(@RequestParam String expression) {
        return parser.parseExpression(expression).getValue(); // expect: SEC-010
    }
}
