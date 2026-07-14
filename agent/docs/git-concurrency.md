# Git Concurrency

Las tareas autónomas que escriben repositorios compartidos deben ejecutarse bajo `/usr/bin/flock -n -E 75 /tmp/symphony-git-write.lock`. El código de lectura y análisis debe usar clones temporales. El código 75 significa que otra tarea ya tiene el bloqueo y no es un fallo.
