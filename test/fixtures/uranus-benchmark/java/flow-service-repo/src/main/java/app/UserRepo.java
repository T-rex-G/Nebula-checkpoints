package app;

public class UserRepo {
  private JdbcTemplate jdbc;
  public Object byName(String name) {
    return jdbc.queryForList("SELECT * FROM u WHERE n = '" + name + "'"); // expect: SEC-001
  }
}
