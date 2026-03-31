cmake_minimum_required(VERSION 3.10)
project(QBE_Server)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Threads REQUIRED)

set(SOURCES
    main.cpp
    sql.cpp
    threadpool.cpp
    mongoose.c
)

add_executable(qbe_server )

target_link_libraries(qbe_server PRIVATE Threads::Threads)

option(USE_MYSQL "Compile with MySQL support" OFF)
if(USE_MYSQL)
    find_package(MySQL REQUIRED)
    target_link_libraries(qbe_server PRIVATE MySQL::MySQL)
    target_compile_definitions(qbe_server PRIVATE USE_MYSQL)
endif()

if(WIN32)
    target_compile_definitions(qbe_server PRIVATE _CRT_SECURE_NO_WARNINGS)
    target_link_libraries(qbe_server PRIVATE ws2_32)
endif()
