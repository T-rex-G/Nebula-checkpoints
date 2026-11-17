<?php
$name = mysqli_real_escape_string($db, $_GET['name']);
$rows = mysqli_query($db, "SELECT * FROM users WHERE name = '" . $name . "'");
