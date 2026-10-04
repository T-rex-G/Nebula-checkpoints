const target = document.getElementById('greeting');
target.innerHTML = decodeURIComponent(location.hash.slice(1)); // expect: SEC-002
