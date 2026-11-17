<?php
$name = htmlspecialchars($_GET['name']);
$rows = mysqli_query($db, "SELECT * FROM users WHERE name = '" . $name . "'"); // expect: SEC-001
