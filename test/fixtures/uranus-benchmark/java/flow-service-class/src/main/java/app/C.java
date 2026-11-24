package app;

import org.springframework.web.bind.annotation.*;

@RestController
public class C {
  private final UserService users;
  C(UserService users) { this.users = users; }
  @GetMapping("/u")
  public Object u(@RequestParam String name) {
    return users.find(name);
  }
}
