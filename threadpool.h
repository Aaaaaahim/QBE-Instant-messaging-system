#pragma once
#include <condition_variable>
#include <cstddef>
#include <functional>
#include <mutex>
#include <queue>
#include <thread>
#include <vector>

class ThreadPool {
private:
	// Thread pool running state.
	bool running_ = false;
	// Worker threads.
	std::vector<std::thread> threads_;
	// Task queue (FIFO).
	std::queue<std::function<void()>> task_queue_;
	// Mutex for queue and state.
	std::mutex queue_mutex_;
	// Wake worker threads when tasks arrive or stopping.
	std::condition_variable wake_threads_;
	// Backpressure for queue capacity.
	std::condition_variable space_available_;
	// Number of threads.
	size_t thread_count_ = 0;
	// Max task queue size.
	size_t task_max_count_ = 1024;
public:
	// Singleton entry; thread_count only used on first call.
	static ThreadPool& instance(size_t thread_count = std::thread::hardware_concurrency(),
	                           size_t max_queue_size = 1024);

	// Disable copy/assign.
	ThreadPool(const ThreadPool&) = delete;
	ThreadPool& operator=(const ThreadPool&) = delete;

	// Start the pool.
	void start();
	// Stop the pool.
	void stop();
	// Add task (blocking when queue full).
	void add_task(std::function<void()> task);
	// Try add task without blocking.
	bool try_add_task(std::function<void()> task);

	// Ensure stop on destruction.
	~ThreadPool();
private:
	// Private constructor; use instance().
	explicit ThreadPool(size_t thread_count, size_t max_queue_size);
	// Worker loop.
	void worker_thread();
};
