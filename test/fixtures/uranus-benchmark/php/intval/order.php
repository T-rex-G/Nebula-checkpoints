<?php
$conn = mysqli_connect('localhost', 'app', getenv('DB_PASSWORD'), 'app');
$id = intval($_GET['id']);
$result = mysqli_query($conn, "SELECT * FROM orders WHERE id = $id");
