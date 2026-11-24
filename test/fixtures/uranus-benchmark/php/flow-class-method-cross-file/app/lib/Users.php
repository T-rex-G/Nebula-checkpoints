<?php
class Users {
  function __construct($db) { $this->db = $db; }
  function find($name) {
    return mysqli_query($this->db, "SELECT * FROM u WHERE n = '$name'"); // expect: SEC-001
  }
}
