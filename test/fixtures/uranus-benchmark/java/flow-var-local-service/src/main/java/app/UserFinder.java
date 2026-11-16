package app;

public class UserFinder {
  private JdbcTemplate jdbc;
  public Object find(String name) {
    return jdbc.queryForList("SELECT * FROM u WHERE n = '" + name + "'"); // expect: SEC-001
  }
}
