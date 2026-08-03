rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function logado() { return request.auth != null; }
    function perfil() { return get(/databases/$(database)/documents/usuarios/$(request.auth.uid)).data; }
    function coordenador() { return logado() && perfil().papel == 'coordenador'; }

    match /usuarios/{uid} {
      allow read: if logado();
      allow create: if logado() && (request.auth.uid == uid || coordenador());
      allow update, delete: if coordenador() || request.auth.uid == uid;
    }
    match /obras/{id} {
      allow read: if logado();
      allow create, update, delete: if coordenador();
    }
    match /cargas/{id} {
      allow read, create, update: if logado();
      allow delete: if coordenador();
    }
    match /fechamentos/{id} {
      allow read, create, update: if logado();
      allow delete: if coordenador();
    }
    match /ensaios/{id} {
      allow read, create, update: if logado();
      allow delete: if coordenador();
    }
    match /projetos/{id} {
      allow read, create, update: if logado();
      allow delete: if coordenador();
    }
    match /equipamentos/{id} {
      allow read, create, update: if logado();
      allow delete: if coordenador();
    }
    match /documentos/{id} {
      allow read, create, update: if logado();
      allow delete: if coordenador() || resource.data.uid == request.auth.uid;
    }
    match /analises/{id} {
      allow read, create, update: if logado();
      allow delete: if coordenador();
    }

    // ---- Módulo Pessoal (ponto · SST · férias) ----
    match /funcionarios/{uid} {
      allow read: if coordenador() || request.auth.uid == uid;
      allow create, delete: if coordenador();
      // O próprio funcionário só altera o contador de NSR ao bater o ponto.
      allow update: if coordenador()
        || (request.auth.uid == uid
            && request.resource.data.diff(resource.data).affectedKeys()
                 .hasOnly(['nsr', 'ultimaMarcacao']));
    }
    match /ponto/{id} {
      allow read: if coordenador() || resource.data.uid == request.auth.uid;
      allow create: if logado() && request.resource.data.uid == request.auth.uid;
      // APPEND-ONLY: nunca se apaga nem se encurta uma marcação registrada.
      allow update: if (coordenador() || resource.data.uid == request.auth.uid)
        && request.resource.data.marcacoes.size() >= resource.data.marcacoes.size();
      allow delete: if false;
    }
    match /empresa/{id} {
      allow read: if logado();
      allow write: if coordenador();
    }

    // ---- Módulo CAP (recebimento de cimento asfáltico) ----
    match /cap/{id} {
      allow read, create, update: if logado();
      allow delete: if coordenador();
    }

    // ---- Módulo Despesas de viagem ----
    match /viagens/{id} {
      allow read: if coordenador() || resource.data.uid == request.auth.uid;
      allow create: if logado() && request.resource.data.uid == request.auth.uid;
      allow update: if coordenador() || resource.data.uid == request.auth.uid;
      allow delete: if coordenador() || resource.data.uid == request.auth.uid;
    }
  }
}
