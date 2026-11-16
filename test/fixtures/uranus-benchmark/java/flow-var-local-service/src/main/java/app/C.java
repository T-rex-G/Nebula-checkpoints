package app;

import org.springframework.web.bind.annotation.*;

@RestController
public class C {
  @GetMapping("/u")
  public Object u(@RequestParam String name) {
    var finder = new UserFinder();
    return finder.find(name);
  }
}
