<?php
function find_user($name) {
  global $db;
  return mysqli_query($db, "SELECT * FROM u WHERE n = '" . $name . "'"); // expect: SEC-001
}
