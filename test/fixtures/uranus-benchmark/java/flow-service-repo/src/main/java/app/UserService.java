package app;

public class UserService {
  private UserRepo repo;
  public Object find(String name) {
    return repo.byName(name);
  }
}
