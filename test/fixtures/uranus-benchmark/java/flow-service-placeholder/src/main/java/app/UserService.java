package app;

public class UserService {
  private JdbcTemplate jdbc;
  public Object find(String name) {
    return jdbc.queryForList("SELECT * FROM u WHERE n = ?", name);
  }
}
